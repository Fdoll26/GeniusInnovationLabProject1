export function getEnv(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function getEnvNumber(name: string): number | undefined {
  const raw = getEnv(name);
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function getEnvInt(name: string): number | undefined {
  const raw = getEnvNumber(name);
  if (typeof raw !== 'number') {
    return undefined;
  }
  return Math.trunc(raw);
}

export function getEnvBool(name: string): boolean | undefined {
  const raw = getEnv(name);
  if (!raw) {
    return undefined;
  }
  if (raw === 'true' || raw === '1') {
    return true;
  }
  if (raw === 'false' || raw === '0') {
    return false;
  }
  return undefined;
}

