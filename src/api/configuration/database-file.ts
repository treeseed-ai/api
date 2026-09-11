import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';

/** Deployment's phase-specific file mount; no fallback after an invalid file. */
export function readDatabaseUrlFile(path: string) {
  if (!/^\/run\/treeseed\/postgres\/[a-z][a-z0-9-]{0,62}\/url$/u.test(path)) throw new Error('Managed database input must use its allocation mount');
  let fd: number | undefined, bytes: Buffer | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size < 1 || stat.size > 16384) throw new Error();
    bytes = readFileSync(fd);
    return validateDatabaseFileUrl(bytes.toString('utf8'), path);
  } catch { throw new Error('Managed database input is unavailable or unsafe'); }
  finally { bytes?.fill(0); if (fd !== undefined) closeSync(fd); }
}

export function validateDatabaseFileUrl(value: string, path: string) {
  const url = new URL(value);
  if (url.protocol !== 'postgresql:' || !url.hostname || !url.username || url.username === 'postgres' || !url.password || url.hash
    || url.searchParams.get('sslmode') !== 'verify-full' || url.searchParams.get('sslrootcert') !== path.replace(/\/url$/u, '/ca.pem')
    || [...url.searchParams.keys()].some(key => !['sslmode', 'sslrootcert'].includes(key)) || [...url.searchParams].length !== 2) throw new Error('Invalid managed database binding');
  return value;
}
