import { Inject, Injectable } from '@nestjs/common';

import type { ApiEnv } from './env.schema';

/** Injection token for the validated environment. */
export const API_ENV = Symbol('API_ENV');

/** Typed, read-only access to the validated environment. */
@Injectable()
export class ConfigService {
  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {}

  get<K extends keyof ApiEnv>(key: K): ApiEnv[K] {
    return this.env[key];
  }
}
