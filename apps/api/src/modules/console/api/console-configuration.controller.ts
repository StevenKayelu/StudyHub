import { Body, Controller, Get, Header, HttpCode, Post, Put } from '@nestjs/common';
import {
  configurationActivateRequestSchema,
  configurationDraftRequestSchema,
  configurationImportRequestSchema,
} from '@studyhub/contracts';

import { ConfigurationService } from '../../configuration';
import { parseOrThrow } from '../../platform';
import { requireRecentReauth, requireRole, requireStaff } from './console-guards';

function owner(sensitive = false) {
  const actor = requireStaff();
  requireRole(actor, 'PLATFORM_OWNER');
  if (sensitive) requireRecentReauth(actor);
  return actor;
}

@Controller('console/configuration')
export class ConsoleConfigurationController {
  constructor(private readonly configuration: ConfigurationService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  get() {
    owner();
    return this.configuration.get('PLATFORM');
  }

  @Put('draft')
  @Header('Cache-Control', 'private, no-store')
  save(@Body() body: unknown) {
    return this.configuration.saveDraft(
      'PLATFORM',
      owner(),
      parseOrThrow(configurationDraftRequestSchema, body),
    );
  }

  @Post('activate')
  @Header('Cache-Control', 'private, no-store')
  @HttpCode(200)
  activate(@Body() body: unknown) {
    return this.configuration.activate(
      'PLATFORM',
      owner(true),
      parseOrThrow(configurationActivateRequestSchema, body),
    );
  }

  @Post('import-preview')
  @Header('Cache-Control', 'private, no-store')
  @HttpCode(200)
  preview(@Body() body: unknown) {
    owner();
    return this.configuration.importPreview(parseOrThrow(configurationImportRequestSchema, body).text);
  }
}
