import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { getFirebaseAuth } from './firebase-admin';

// Augments Express's Request type globally so `request.user` is known
// everywhere in the app — no more `(req as any).user`.
declare module 'express' {
  interface Request {
    user?: {
      uid: string;
      email?: string;
      name?: string;
      picture?: string;
    };
  }
}

// CanActivate is Nest's interface for "should this request be allowed
// to reach the route handler at all?" Guards run BEFORE the controller
// method, so an unverified request never touches your business logic.
@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    // ExecutionContext is generic (works for HTTP, WebSockets, RPC).
    // switchToHttp() narrows it down to the plain Express request/response.
    const request = context.switchToHttp().getRequest<Request>();
    const authHeader = request.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const idToken = authHeader.slice('Bearer '.length);

    try {
      // This call verifies the token's signature against Firebase's
      // public keys AND checks it hasn't expired — a client can't forge
      // this no matter what uid they claim in the raw JWT payload.
      const decoded = await getFirebaseAuth().verifyIdToken(idToken);

      request.user = {
        uid: decoded.uid,
        email: decoded.email,
        name: decoded.name,
        picture: decoded.picture,
      };

      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
