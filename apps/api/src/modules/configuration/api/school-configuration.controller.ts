import { Body, Controller, Get, Header, HttpCode, Post, Put } from '@nestjs/common';
import {
  configurationActivateRequestSchema,
  configurationDraftRequestSchema,
  configurationImportRequestSchema,
} from '@studyhub/contracts';

import { can, currentActor } from '../../identity';
import { AppError, parseOrThrow } from '../../platform';
import { ConfigurationService } from '../application/configuration.service';

function administrator(write = false) {
  const actor = currentActor();
  if (actor === null) throw new AppError('UNAUTHENTICATED');
  if (!can(actor, 'admin.access')) throw new AppError('FORBIDDEN');
  if (write && actor.support?.scope === 'READ_ONLY') throw new AppError('SUPPORT_READ_ONLY');
  return actor;
}

@Controller('api/v1/admin/configuration')
export class SchoolConfigurationController {
  constructor(private readonly configuration: ConfigurationService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  get() {
    administrator();
    return this.configuration.get('SCHOOL');
  }

  @Put('draft')
  @Header('Cache-Control', 'private, no-store')
  save(@Body() body: unknown) {
    return this.configuration.saveDraft(
      'SCHOOL',
      administrator(true),
      parseOrThrow(configurationDraftRequestSchema, body),
    );
  }

  @Post('activate')
  @Header('Cache-Control', 'private, no-store')
  @HttpCode(200)
  activate(@Body() body: unknown) {
    return this.configuration.activate(
      'SCHOOL',
      administrator(true),
      parseOrThrow(configurationActivateRequestSchema, body),
    );
  }

  @Post('import-preview')
  @Header('Cache-Control', 'private, no-store')
  @HttpCode(200)
  preview(@Body() body: unknown) {
    administrator();
    return this.configuration.importPreview(parseOrThrow(configurationImportRequestSchema, body).text);
  }
}
