import { randomBytes } from 'node:crypto';

export function generateGalleryId() {
  return randomBytes(16).toString('base64url');
}
