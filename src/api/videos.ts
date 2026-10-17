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

  const key = `${videoId}.mp4`;
  const tempFilePath = path.join("/tmp", key);
  await Bun.write(tempFilePath, videoFile);

  try {
    const s3file = cfg.s3Client.file(key, { type: videoFile.type });
    await s3file.write(Bun.file(tempFilePath));

    video.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${key}`;
    updateVideo(cfg.db, video);
  } finally {
    await unlink(tempFilePath);
  }

  return respondWithJSON(200, video);
}
