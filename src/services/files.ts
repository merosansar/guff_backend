import { basename } from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { imageSize } from 'image-size';
import mongoose, { Types } from 'mongoose';
import { HttpError, badRequest, forbidden, notFound } from '../lib/errors.js';
import type { TokenService } from '../lib/tokens.js';
import type { Attachment } from '../models/message.js';
import type { AttachmentDto } from './dto.js';

const BUCKET = 'uploads';

/** What can be shared. The type comes from the file's bytes, never from the browser. */
const ALLOWED = new Map<string, { inline: boolean }>([
  ['image/png', { inline: true }],
  ['image/jpeg', { inline: true }],
  ['image/gif', { inline: true }],
  ['image/webp', { inline: true }],
  ['application/pdf', { inline: true }],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', { inline: false }],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', { inline: false }],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', { inline: false }],
  ['application/zip', { inline: false }],
  ['text/plain; charset=utf-8', { inline: false }],
  ['audio/webm', { inline: true }],
  ['audio/ogg', { inline: true }],
  ['audio/mp4', { inline: true }],
  ['audio/mpeg', { inline: true }],
]);

/**
 * Recorders write audio into containers that also hold video, so the bytes alone can't
 * tell. For a voice message (the browser says so) these count as audio.
 */
const VOICE_TYPES = new Map<string, string>([
  ['video/webm', 'audio/webm'],
  ['audio/webm', 'audio/webm'],
  ['audio/ogg', 'audio/ogg'],
  ['audio/opus', 'audio/ogg'],
  ['video/mp4', 'audio/mp4'],
  ['audio/mp4', 'audio/mp4'],
  ['audio/x-m4a', 'audio/mp4'],
  ['audio/aac', 'audio/mp4'],
]);
const AUDIO_TYPES = new Map<string, string>([
  ['audio/mpeg', 'audio/mpeg'],
  ['audio/ogg', 'audio/ogg'],
  ['audio/x-m4a', 'audio/mp4'],
  ['audio/mp4', 'audio/mp4'],
  ['audio/webm', 'audio/webm'],
]);

/** Five minutes of voice is plenty. */
export const MAX_VOICE_MS = 5 * 60_000;

export interface VoiceInfo {
  durationMs: number;
  waveform: number[];
}

const TEXT_NAMES = /\.(txt|md|csv|log|json|ya?ml)$/i;

interface FileMetadata {
  uploaderId: Types.ObjectId;
  contentType: string;
  width: number | null;
  height: number | null;
  durationMs?: number | null;
  waveform?: number[] | null;
  /** Set when the file is attached to a message. Unattached files are removed after a day. */
  channelId: Types.ObjectId | null;
}

interface StoredFile {
  _id: Types.ObjectId;
  filename: string;
  length: number;
  uploadDate: Date;
  metadata: FileMetadata;
}

function isUtf8Text(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function cleanName(original: string): string {
  // Browsers send latin1-decoded names through multer; recover UTF-8 names (e.g. Nepali).
  let name = original;
  try {
    const recoded = Buffer.from(original, 'latin1').toString('utf8');
    if (!recoded.includes('�')) name = recoded;
  } catch {
    /* keep the original */
  }
  name = basename(name.replace(/\\/g, '/'))
    // oxlint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f"<>|]/g, '')
    .trim();
  if (name.length > 120) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : '';
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return name || 'file';
}

export class FileService {
  constructor(private readonly tokens: TokenService) {}

  private get bucket() {
    const db = mongoose.connection.db;
    if (!db) throw new Error('Database not connected');
    return new mongoose.mongo.GridFSBucket(db, { bucketName: BUCKET });
  }

  private get files() {
    const db = mongoose.connection.db;
    if (!db) throw new Error('Database not connected');
    return db.collection<StoredFile>(`${BUCKET}.files`);
  }

  async upload(
    uploaderId: string,
    file: { buffer: Buffer; originalname: string },
    voice?: VoiceInfo,
  ): Promise<AttachmentDto> {
    if (file.buffer.length === 0) throw badRequest('That file is empty.');
    const name = cleanName(file.originalname);

    const detected = await fileTypeFromBuffer(file.buffer);
    let contentType: string | null = detected?.mime ?? null;
    if (contentType && voice) contentType = VOICE_TYPES.get(contentType) ?? null;
    else if (contentType && AUDIO_TYPES.has(contentType)) contentType = AUDIO_TYPES.get(contentType)!;
    if (voice && !contentType) {
      throw new HttpError(415, 'That recording format isn’t supported. Try another browser.');
    }
    if (!contentType && TEXT_NAMES.test(name) && isUtf8Text(file.buffer)) {
      contentType = 'text/plain; charset=utf-8';
    }
    if (!contentType || !ALLOWED.has(contentType)) {
      throw new HttpError(
        415,
        'That kind of file can’t be shared here. Images, PDFs, Office documents, zip and text files work.',
      );
    }

    let width: number | null = null;
    let height: number | null = null;
    if (contentType.startsWith('image/')) {
      try {
        const size = imageSize(file.buffer);
        width = size.width ?? null;
        height = size.height ?? null;
      } catch {
        throw badRequest('That image looks damaged. Try saving it again.');
      }
      if (!width || !height || width * height > 60_000_000) {
        throw badRequest('That image is too large to show. Keep it under 60 megapixels.');
      }
    }

    const id = new Types.ObjectId();
    const durationMs = voice ? Math.round(Math.min(Math.max(voice.durationMs, 0), MAX_VOICE_MS)) : null;
    const waveform = voice
      ? voice.waveform.slice(0, 64).map((v) => Math.round(Math.min(Math.max(v, 0), 100)))
      : null;
    const metadata: FileMetadata = {
      uploaderId: new Types.ObjectId(uploaderId),
      contentType,
      width,
      height,
      durationMs,
      waveform,
      channelId: null,
    };
    await new Promise<void>((resolve, reject) => {
      const stream = this.bucket.openUploadStreamWithId(id, name, { metadata });
      stream.once('finish', () => resolve());
      stream.once('error', reject);
      stream.end(file.buffer);
    });

    return this.toDto({
      fileId: id,
      name,
      size: file.buffer.length,
      contentType,
      width,
      height,
      durationMs,
      waveform,
    });
  }

  /** Attaches uploaded files to a message. Only the uploader can attach them, and only once. */
  async claim(uploaderId: string, fileIds: string[], channelId: string): Promise<Attachment[]> {
    if (fileIds.length === 0) return [];
    const ids = [...new Set(fileIds)].map((id) => new Types.ObjectId(id));
    const found = await this.files
      .find({
        _id: { $in: ids },
        'metadata.uploaderId': new Types.ObjectId(uploaderId),
        'metadata.channelId': null,
      })
      .toArray();
    if (found.length !== ids.length) {
      throw badRequest('One of the attachments isn’t available any more. Attach it again.');
    }
    const claimed = await this.files.updateMany(
      { _id: { $in: ids }, 'metadata.channelId': null },
      { $set: { 'metadata.channelId': new Types.ObjectId(channelId) } },
    );
    if (claimed.modifiedCount !== ids.length) {
      throw badRequest('One of the attachments was already sent. Attach it again.');
    }
    const byId = new Map(found.map((f) => [f._id.toString(), f]));
    return ids.map((id) => {
      const f = byId.get(id.toString())!;
      return {
        fileId: f._id,
        name: f.filename,
        size: f.length,
        contentType: f.metadata.contentType,
        width: f.metadata.width,
        height: f.metadata.height,
        durationMs: f.metadata.durationMs ?? null,
        waveform: f.metadata.waveform ?? null,
      };
    });
  }

  async open(fileId: string, exp: number, sig: string) {
    if (!this.tokens.verifyFileSignature(fileId, exp, sig)) {
      throw forbidden('This file link has expired. Reload the conversation to get a fresh one.');
    }
    const file = await this.files.findOne({ _id: new Types.ObjectId(fileId) });
    if (!file) throw notFound('That file was deleted.');
    const inline = ALLOWED.get(file.metadata.contentType)?.inline ?? false;
    return {
      name: file.filename,
      size: file.length,
      contentType: file.metadata.contentType,
      inline,
      /** `end` is exclusive, as GridFS expects. */
      stream: (range?: { start: number; end: number }) =>
        this.bucket.openDownloadStream(file._id, range),
    };
  }

  async remove(fileIds: Types.ObjectId[]): Promise<void> {
    for (const id of fileIds) {
      try {
        await this.bucket.delete(id);
      } catch {
        /* already gone */
      }
    }
  }

  /** Uploads that were never sent (the tab closed, the person changed their mind). */
  async removeOrphans(olderThanMs = 86_400_000): Promise<number> {
    const stale = await this.files
      .find(
        { 'metadata.channelId': null, uploadDate: { $lt: new Date(Date.now() - olderThanMs) } },
        { projection: { _id: 1 } },
      )
      .toArray();
    await this.remove(stale.map((f) => f._id));
    return stale.length;
  }

  toDto(a: Attachment): AttachmentDto {
    const id = a.fileId.toString();
    return {
      id,
      name: a.name,
      size: a.size,
      contentType: a.contentType,
      width: a.width,
      height: a.height,
      url: this.tokens.signFileUrl(id),
      durationMs: a.durationMs ?? null,
      waveform: a.waveform ?? null,
    };
  }
}
