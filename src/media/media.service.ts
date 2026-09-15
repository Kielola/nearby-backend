import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';

@Injectable()
export class MediaService {
  constructor(private readonly config: ConfigService) {
    cloudinary.config({
      cloud_name: this.config.get('CLOUDINARY_CLOUD_NAME'),
      api_key: this.config.get('CLOUDINARY_API_KEY'),
      api_secret: this.config.get('CLOUDINARY_API_SECRET'),
    });
  }

  // The client uploads DIRECTLY to Cloudinary using this signature —
  // large image/video bytes never pass through our server at all. We
  // just prove to Cloudinary "yes, this specific upload was authorized
  // by our backend" without our server doing the heavy lifting.
  generateUploadSignature(folder: string) {
    const timestamp = Math.round(Date.now() / 1000);
    const paramsToSign = { timestamp, folder };

    const signature = cloudinary.utils.api_sign_request(
      paramsToSign,
      this.config.getOrThrow('CLOUDINARY_API_SECRET'),
    );

    return {
      signature,
      timestamp,
      folder,
      apiKey: this.config.get('CLOUDINARY_API_KEY'),
      cloudName: this.config.get('CLOUDINARY_CLOUD_NAME'),
    };
  }
}
