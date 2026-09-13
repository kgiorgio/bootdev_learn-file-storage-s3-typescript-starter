import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import path from "path";
import { randomBytes } from "crypto";

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }
  if (video.userID !== userID) {
    throw new UserForbiddenError("Not authorized to upload the thumbnail");
  }
  const result = await req.formData();
  const thumbnail = result.get("thumbnail");
  if (!(thumbnail instanceof File)) {
    throw new BadRequestError("Thumnail is missing");
  }
  const MAX_UPLOAD_SIZE = 10 << 20;
  if (thumbnail.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Thumbnail is too large");
  }

  const thumbnailData = await thumbnail.arrayBuffer();
  const thumbnailMediaType = thumbnail.type;
  const thumbnailExtension = thumbnailMediaType.split("/")[1];
  if (!thumbnailExtension) {
    throw new BadRequestError("Empty thumbnail extension");
  }

  const fileName = randomBytes(32).toString("base64url");
  const assetPath = path.join(
    cfg.assetsRoot,
    `${fileName}.${thumbnailExtension}`,
  );
  await Bun.write(assetPath, thumbnailData);

  video.thumbnailURL = `http://localhost:${cfg.port}/assets/${fileName}.${thumbnailExtension}`;

  updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}
