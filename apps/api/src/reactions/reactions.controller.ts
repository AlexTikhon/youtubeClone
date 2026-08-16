import {
  Controller,
  Delete,
  Inject,
  Param,
  ParseUUIDPipe,
  Put,
  UseGuards,
} from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { SessionGuard } from '../auth/session.guard.js';
import { RateLimit } from '../infrastructure/http/rate-limit.decorator.js';
import { RateLimitGuard } from '../infrastructure/http/rate-limit.guard.js';
import { ReactionsService } from './reactions.service.js';

@Controller('videos/:videoId/like')
@UseGuards(SessionGuard, RateLimitGuard)
export class ReactionsController {
  constructor(
    @Inject(ReactionsService) private readonly reactions: ReactionsService,
  ) {}
  @Put()
  @RateLimit({ scope: 'likes', limit: 60, windowSeconds: 60 })
  like(
    @Param('videoId', ParseUUIDPipe) videoId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reactions.like(videoId, user.id);
  }
  @Delete()
  @RateLimit({ scope: 'likes', limit: 60, windowSeconds: 60 })
  unlike(
    @Param('videoId', ParseUUIDPipe) videoId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reactions.unlike(videoId, user.id);
  }
}
