import { respondWithJSON } from "./json";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { unlink } from "node:fs/promises";
import path from "node:path";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const MAX_UPLOAD_SIZE = 1 << 30;

  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading video for video", videoId, "by user", userID);

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }
  if (video.userID !== userID) {
    throw new UserForbiddenError("Not authorized to upload the video");
  }

  const formData = await req.formData();
  const videoFile = formData.get("video");
  if (!(videoFile instanceof File)) {
    throw new BadRequestError("Video is missing");
  }
  if (videoFile.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Video is too large");
  }
  if (videoFile.type !== "video/mp4") {
    throw new BadRequestError("Invalid video file type");
  }

  const tempFilePath = path.join("/tmp", `${videoId}.mp4`);
  await Bun.write(tempFilePath, videoFile);

  let processedFilePath = "";
  try {
    const aspectRatio = await getVideoAspectRatio(tempFilePath);
    processedFilePath = await processVideoForFastStart(tempFilePath);
    const key = `${aspectRatio}/${videoId}.mp4`;

    const s3file = cfg.s3Client.file(key, { type: videoFile.type });
    await s3file.write(Bun.file(processedFilePath));

    video.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${key}`;
    updateVideo(cfg.db, video);
  } finally {
    await unlink(tempFilePath).catch(() => {});
    if (processedFilePath) {
      await unlink(processedFilePath).catch(() => {});
    }
  }

  return respondWithJSON(200, video);
}

export async function processVideoForFastStart(
  inputFilePath: string,
): Promise<string> {
  const outputFilePath = `${inputFilePath}.processed`;
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-i",
      inputFilePath,
      "-movflags",
      "faststart",
      "-map_metadata",
      "0",
      "-codec",
      "copy",
      "-f",
      "mp4",
      outputFilePath,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const stdoutText = await new Response(proc.stdout).text();
  const stderrText = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(
      `ffmpeg faststart failed: ${stderrText || stdoutText}`,
    );
  }

  return outputFilePath;
}

export async function getVideoAspectRatio(filePath: string): Promise<string> {
  const proc = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      filePath,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const stdoutText = await new Response(proc.stdout).text();
  const stderrText = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`ffprobe failed: ${stderrText}`);
  }

  const parsed = JSON.parse(stdoutText) as {
    streams?: Array<{ width?: number; height?: number }>;
  };
  const width = parsed.streams?.[0]?.width;
  const height = parsed.streams?.[0]?.height;
  if (!width || !height) {
    throw new Error("Could not determine video dimensions");
  }

  const ratio = width / height;
  if (Math.abs(ratio - 16 / 9) < 0.1) {
    return "landscape";
  }
  if (Math.abs(ratio - 9 / 16) < 0.1) {
    return "portrait";
  }
  return "other";
}
