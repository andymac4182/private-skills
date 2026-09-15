import { describe, expect, it } from 'vitest';

import { loopbackDatabaseURL } from './loopback-database.js';

describe('loopback integration database guard', () => {
  it('accepts only local PostgreSQL URLs and never echoes configured values', () => {
    expect(loopbackDatabaseURL(['TEST_DATABASE_URL', 'postgresql://user:secret@127.0.0.1:5432/test'])).toContain('127.0.0.1');
    expect(() => loopbackDatabaseURL(['TEST_DATABASE_URL', 'postgresql://user:secret@db.example.test:5432/test']))
      .toThrow('TEST_DATABASE_URL must use a loopback PostgreSQL host');
    expect(() => loopbackDatabaseURL(['TEST_DATABASE_URL', 'not-a-url']))
      .toThrow('TEST_DATABASE_URL must be a valid loopback PostgreSQL URL');
  });
});
