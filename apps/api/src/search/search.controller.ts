import {
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  searchQuerySchema,
  type SearchQueryInput,
} from '@youtube-clone/validation';

import { OptionalSessionGuard } from '../auth/optional-session.guard.js';
import { RateLimit } from '../infrastructure/http/rate-limit.decorator.js';
import { RateLimitGuard } from '../infrastructure/http/rate-limit.guard.js';
import type { RequestWithContext } from '../infrastructure/http/request-context.js';
import { ZodBodyPipe } from '../infrastructure/http/zod-body.pipe.js';
import { SearchService } from './search.service.js';

const relatedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(12),
});

@ApiTags('discovery')
@Controller()
export class SearchController {
  constructor(@Inject(SearchService) private readonly search: SearchService) {}

  @Get('search')
  @UseGuards(RateLimitGuard)
  @RateLimit({ scope: 'search', limit: 30, windowSeconds: 60 })
  @ApiOperation({
    summary: 'Search public playable videos with PostgreSQL FTS',
  })
  searchVideos(
    @Query(new ZodBodyPipe(searchQuerySchema)) query: SearchQueryInput,
  ) {
    return this.search.search(query.q, query.cursor, query.limit);
  }

  @Get('videos/:videoId/related')
  @UseGuards(OptionalSessionGuard)
  @ApiOperation({ summary: 'List bounded interpretable related videos' })
  related(
    @Param('videoId', ParseUUIDPipe) videoId: string,
    @Req() request: RequestWithContext,
    @Query(new ZodBodyPipe(relatedQuerySchema)) query: { limit: number },
  ) {
    return this.search.related(videoId, request.user?.id, query.limit);
  }
}
