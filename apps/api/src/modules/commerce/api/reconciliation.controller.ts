import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { createSettlementRequestSchema, resolveSettlementItemSchema } from '@studyhub/contracts';

import { currentActor, type TenantActor } from '../../identity';
import { AppError, parseOrThrow } from '../../platform';
import { ReconciliationService } from '../application/reconciliation.service';

function requireActor(): TenantActor {
  const actor = currentActor();
  if (actor === null) throw new AppError('UNAUTHENTICATED');
  return actor;
}

const uuid = () => new ParseUUIDPipe();

/** Provider settlement reconciliation (W7, S-AD20; 05 §8.3). */
@Controller('api/v1/admin/reconciliation/settlements')
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  list() {
    return this.reconciliation.list(requireActor());
  }

  @Post()
  @HttpCode(201)
  create(@Body() body: unknown) {
    return this.reconciliation.create(requireActor(), parseOrThrow(createSettlementRequestSchema, body));
  }

  @Get(':id')
  @Header('Cache-Control', 'private, no-store')
  detail(@Param('id', uuid()) id: string) {
    return this.reconciliation.detail(requireActor(), id);
  }

  @Post(':id/items/:itemId/resolve')
  @HttpCode(204)
  async resolve(
    @Param('id', uuid()) id: string,
    @Param('itemId', uuid()) itemId: string,
    @Body() body: unknown,
  ): Promise<void> {
    await this.reconciliation.resolve(
      requireActor(),
      id,
      itemId,
      parseOrThrow(resolveSettlementItemSchema, body),
    );
  }
}
