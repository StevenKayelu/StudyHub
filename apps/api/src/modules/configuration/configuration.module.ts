import { Module } from '@nestjs/common';

import { SchoolConfigurationController } from './api/school-configuration.controller';
import { ConfigurationService } from './application/configuration.service';

@Module({
  controllers: [SchoolConfigurationController],
  providers: [ConfigurationService],
  exports: [ConfigurationService],
})
export class ConfigurationModule {}
