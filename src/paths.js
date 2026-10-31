import { realpath, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export function linuxPath(value, { distro = process.env.WSL_DISTRO_NAME || 'Ubuntu' } = {}) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.length > 4096) throw Error('Invalid absolute cwd');
  const unc = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(\\.*)?$/i.exec(value);
  if (unc) {
    if (unc[1].toLowerCase() !== distro.toLowerCase()) throw Error('cwd belongs to another WSL distro');
    return (unc[2] || '/').replaceAll('\\', '/');
  }
  if (/^[A-Za-z]:[\\/]/.test(value)) return '/mnt/' + value[0].toLowerCase() + value.slice(2).replaceAll('\\', '/');
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  throw Error('Use an absolute Linux path, local Windows drive or this WSL distro UNC path');
}
export async function resolveProject(value, options) {
  const cwd = await realpath(linuxPath(value, options));
  if (!(await stat(cwd)).isDirectory()) throw Error('cwd must be an existing directory');
  let project = cwd;
  try {
    const { stdout } = await exec('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { timeout: 5000, maxBuffer: 8192 });
    project = await realpath(stdout.trim());
  } catch (error) {
    // A non-repository is valid; timeout/missing git is not a safe lock identity.
    if (error.code !== 128) throw Error('Cannot determine project root: check git and directory ownership');
  }
  return { cwd, project };
}
