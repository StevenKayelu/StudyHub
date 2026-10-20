import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Harness, SCHOOLS, startHarness } from '../setup/school-harness';

describe('development video uploads stay with their issuing member and school (T-ISO-23)', () => {
  let h: Harness;
  let owner = '';
  let colleague = '';
  const foreignActors: Array<{ name: string; cookie?: string }> = [{ name: 'anonymous' }];

  beforeAll(async () => {
    h = await startHarness();
    for (const [name, role] of [
      ['owner', 'TENANT_OWNER'],
      ['admin', 'TENANT_ADMIN'],
      ['instructor', 'INSTRUCTOR'],
      ['learner', null],
    ] as const) {
      const email = `${name}-video@beta.test`;
      await h.member(SCHOOLS.beta, h.tenants.beta, email);
      if (role !== null) await h.grantRole(h.tenants.beta, email, role);
      foreignActors.push({ name, cookie: await h.signIn(SCHOOLS.beta, email) });
    }
    for (const name of ['uploader', 'colleague']) {
      const email = `${name}-video@acme.test`;
      await h.member(SCHOOLS.acme, h.tenants.acme, email);
      await h.grantRole(h.tenants.acme, email, 'INSTRUCTOR');
      const cookie = await h.signIn(SCHOOLS.acme, email);
      if (name === 'uploader') owner = cookie;
      else colleague = cookie;
    }
  });
  afterAll(async () => {
    await h?.close();
  });

  async function video() {
    const created = await h.call('POST', '/api/v1/videos', {
      host: SCHOOLS.acme,
      cookie: owner,
      body: { fileName: 'isolation.mp4', mime: 'video/mp4', sizeBytes: 2048 },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { assetId: string }).assetId;
    const { rows } = await h.asTenant(h.tenants.acme, () =>
      h.migrator.query<{ provider_video_id: string }>('SELECT provider_video_id FROM asset WHERE id = $1', [
        id,
      ]),
    );
    return { id, url: `/api/v1/dev/fake-video/${encodeURIComponent(rows[0]!.provider_video_id)}` };
  }

  async function snapshot(id: string) {
    return h.asTenant(h.tenants.acme, async () => ({
      asset: (await h.migrator.query('SELECT * FROM asset WHERE id = $1', [id])).rows,
      usage: (await h.migrator.query('SELECT * FROM tenant_usage')).rows,
    }));
  }

  it('all foreign-school roles are refused without changing the asset or usage', async () => {
    const asset = await video();
    const before = await snapshot(asset.id);
    for (const actor of foreignActors) {
      const response = await h.call('PUT', asset.url, {
        host: SCHOOLS.beta,
        ...(actor.cookie !== undefined && { cookie: actor.cookie }),
      });
      expect(response.statusCode, `${actor.name}: ${response.body}`).toBe(
        actor.cookie === undefined ? 401 : 404,
      );
      expect(await snapshot(asset.id)).toEqual(before);
    }
  });

  it('another instructor at the same school cannot finish the upload either', async () => {
    const asset = await video();
    const before = await snapshot(asset.id);
    const response = await h.call('PUT', asset.url, { host: SCHOOLS.acme, cookie: colleague });
    expect(response.statusCode, response.body).toBe(404);
    expect(await snapshot(asset.id)).toEqual(before);
  });

  it('the issuing member can complete and retry their own video without double-counting usage', async () => {
    const asset = await video();
    expect((await h.call('PUT', asset.url, { host: SCHOOLS.acme, cookie: owner })).statusCode).toBe(200);
    const ready = await snapshot(asset.id);
    expect(ready.asset[0]?.status).toBe('READY');
    expect((await h.call('PUT', asset.url, { host: SCHOOLS.acme, cookie: owner })).statusCode).toBe(200);
    expect(await snapshot(asset.id)).toEqual(ready);
  });
});
