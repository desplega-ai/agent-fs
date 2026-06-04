export type {
  BufferEncoding,
  ByteString,
  CpOptions,
  DirectoryEntry,
  DirentEntry,
  FileContent,
  FileEntry,
  FileInit,
  FileSystemFactory,
  FsEntry,
  FsStat,
  IFileSystem,
  InitialFiles,
  LazyFileEntry,
  LazyFileProvider,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  SymlinkEntry,
  WriteFileOptions,
} from "./types.js";

import type {
  BufferEncoding,
  ByteString,
  CpOptions,
  DirentEntry,
  FileContent,
  FileInit,
  FsStat,
  IFileSystem,
  InitialFiles,
  LazyFileProvider,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  WriteFileOptions,
} from "./types.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:7433";
const DEFAULT_DIR_MODE = 0o755;
const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIRECTORY_MARKER = ".agent-fs-dir";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface AgentFsLsEntry {
  name: string;
  type: "file" | "directory";
  size: number;
  modifiedAt?: string | Date;
}

interface AgentFsLsResult {
  entries: AgentFsLsEntry[];
}

interface AgentFsStatResult {
  size: number;
  modifiedAt?: string | Date;
  createdAt?: string | Date;
}

export interface AgentFsFileSystemOptions {
  baseUrl?: string;
  apiKey?: string;
  orgId: string;
  driveId: string;
  fetch?: FetchLike;
  directoryMarkerName?: string;
  writeMessage?: string | ((operation: string, path: string) => string);
}

export class AgentFsHttpError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "AgentFsHttpError";
    this.status = status;
    this.code = code;
  }
}

export class AgentFsFileSystem implements IFileSystem {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly orgId: string;
  private readonly driveId: string;
  private readonly fetchFn: FetchLike;
  private readonly directoryMarkerName: string;
  private readonly writeMessage?: string | ((operation: string, path: string) => string);
  private readonly knownFiles = new Set<string>();
  private readonly knownDirectories = new Set<string>(["/"]);

  constructor(options: AgentFsFileSystemOptions) {
    if (!options.orgId) {
      throw new Error("AgentFsFileSystem requires orgId");
    }
    if (!options.driveId) {
      throw new Error("AgentFsFileSystem requires driveId");
    }

    this.baseUrl = stripTrailingSlash(
      options.baseUrl ?? getEnv("AGENT_FS_API_URL") ?? DEFAULT_BASE_URL,
    );
    this.apiKey = options.apiKey ?? getEnv("AGENT_FS_API_KEY") ?? undefined;
    this.orgId = options.orgId;
    this.driveId = options.driveId;
    this.fetchFn = options.fetch ?? globalThis.fetch?.bind(globalThis);
    this.directoryMarkerName =
      options.directoryMarkerName ?? DEFAULT_DIRECTORY_MARKER;
    this.writeMessage = options.writeMessage;

    if (!this.fetchFn) {
      throw new Error("AgentFsFileSystem requires a fetch implementation");
    }
  }

  async readFile(
    path: string,
    options?: ReadFileOptions | BufferEncoding,
  ): Promise<string> {
    const bytes = await this.readFileBuffer(path);
    return decodeBytes(bytes, getEncoding(options));
  }

  async readFileBytes(path: string): Promise<ByteString> {
    return bytesToLatin1(await this.readFileBuffer(path)) as ByteString;
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    validatePath(path, "open");
    const normalized = normalizePath(path);
    try {
      const bytes = await this.getRaw(normalized);
      this.rememberFile(normalized);
      return bytes;
    } catch (err) {
      if (isNotFound(err) && (await this.directoryExists(normalized))) {
        throw new Error(`EISDIR: illegal operation on a directory, read '${path}'`);
      }
      throw toPathError(err, "open", path);
    }
  }

  async writeFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    validatePath(path, "write");
    const normalized = normalizePath(path);
    await this.assertParentWritable(normalized, "write");
    await this.putRaw(
      normalized,
      encodeContent(content, getEncoding(options)),
      this.messageFor("write", normalized),
    );
    this.rememberFile(normalized);
  }

  async appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    validatePath(path, "append");
    const normalized = normalizePath(path);
    await this.assertParentWritable(normalized, "append");

    let existing: Uint8Array = new Uint8Array(0);
    try {
      existing = await this.readFileBuffer(normalized);
    } catch (err) {
      if (!isNotFound(err) && !isPathNotFound(err)) {
        throw err;
      }
    }

    const next = concatBytes(existing, encodeContent(content, getEncoding(options)));
    await this.putRaw(normalized, next, this.messageFor("append", normalized));
    this.rememberFile(normalized);
  }

  async exists(path: string): Promise<boolean> {
    if (path.includes("\0")) return false;
    const normalized = normalizePath(path);
    if (normalized === "/") return true;

    try {
      await this.stat(normalized);
      return true;
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<FsStat> {
    validatePath(path, "stat");
    const normalized = normalizePath(path);
    if (normalized === "/") return directoryStat();

    try {
      const result = await this.op<AgentFsStatResult>("stat", { path: normalized });
      this.rememberFile(normalized);
      return fileStat(result);
    } catch (err) {
      if (!isNotFound(err) && !isPathNotFound(err)) {
        throw err;
      }
    }

    if (await this.directoryExists(normalized)) {
      this.rememberDirectory(normalized);
      return directoryStat();
    }

    throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    validatePath(path, "mkdir");
    const normalized = normalizePath(path);
    if (normalized === "/") return;

    const existing = await this.exists(normalized);
    if (existing) {
      if (options?.recursive) return;
      throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
    }

    await this.assertParentDirectory(normalized, "mkdir", Boolean(options?.recursive));
    const marker = this.markerPath(normalized);
    await this.putRaw(marker, new Uint8Array(0), this.messageFor("mkdir", normalized));
    this.rememberDirectory(normalized);
    this.rememberFile(marker);
  }

  async readdir(path: string): Promise<string[]> {
    const entries = await this.readdirWithFileTypes(path);
    return entries.map((entry) => entry.name);
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    validatePath(path, "scandir");
    const normalized = normalizePath(path);
    await this.assertDirectoryReadable(normalized, path);
    const entries = await this.listDirectory(normalized, false);
    return entries
      .map((entry) => ({
        name: entry.name,
        isFile: entry.type === "file",
        isDirectory: entry.type === "directory",
        isSymbolicLink: false,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    validatePath(path, "rm");
    const normalized = normalizePath(path);
    if (normalized === "/") {
      throw new Error(`EBUSY: resource busy or locked, rm '${path}'`);
    }

    const fileExists = await this.fileExists(normalized);
    if (fileExists) {
      await this.op("rm", { path: normalized });
      this.forgetFile(normalized);
      return;
    }

    const directoryEntries = await this.listDirectory(normalized, true);
    const directoryExists =
      directoryEntries.length > 0 || this.knownDirectories.has(normalized);
    if (!directoryExists) {
      if (options?.force) return;
      throw new Error(`ENOENT: no such file or directory, rm '${path}'`);
    }

    const visibleEntries = directoryEntries.filter(
      (entry) => !this.isDirectoryMarkerName(entry.name),
    );
    if (visibleEntries.length > 0 && !options?.recursive) {
      throw new Error(`ENOTEMPTY: directory not empty, rm '${path}'`);
    }

    const files = await this.collectFilePaths(normalized);
    for (const file of files) {
      await this.op("rm", { path: file });
      this.forgetFile(file);
    }
    this.forgetDirectory(normalized);
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    validatePath(src, "cp");
    validatePath(dest, "cp");
    const srcNorm = normalizePath(src);
    const destNorm = normalizePath(dest);
    await this.assertParentWritable(destNorm, "cp");

    if (await this.fileExists(srcNorm)) {
      await this.op("cp", { from: srcNorm, to: destNorm });
      this.rememberFile(destNorm);
      return;
    }

    if (!(await this.directoryExists(srcNorm))) {
      throw new Error(`ENOENT: no such file or directory, cp '${src}'`);
    }
    if (!options?.recursive) {
      throw new Error(`EISDIR: illegal operation on a directory, cp '${src}'`);
    }

    await this.mkdir(destNorm, { recursive: true });
    const entries = await this.listDirectory(srcNorm, false);
    for (const entry of entries) {
      const childSrc = joinPath(srcNorm, entry.name);
      const childDest = joinPath(destNorm, entry.name);
      if (entry.type === "directory") {
        await this.cp(childSrc, childDest, { recursive: true });
      } else {
        await this.cp(childSrc, childDest);
      }
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    validatePath(src, "rename");
    validatePath(dest, "rename");
    const srcNorm = normalizePath(src);
    const destNorm = normalizePath(dest);
    await this.assertParentWritable(destNorm, "rename");

    if (await this.fileExists(srcNorm)) {
      await this.op("mv", {
        from: srcNorm,
        to: destNorm,
        message: this.messageFor("mv", destNorm),
      });
      this.forgetFile(srcNorm);
      this.rememberFile(destNorm);
      return;
    }

    if (!(await this.directoryExists(srcNorm))) {
      throw new Error(`ENOENT: no such file or directory, rename '${src}'`);
    }

    await this.cp(srcNorm, destNorm, { recursive: true });
    await this.rm(srcNorm, { recursive: true });
  }

  resolvePath(base: string, path: string): string {
    if (path.startsWith("/")) {
      return normalizePath(path);
    }
    return normalizePath(base === "/" ? `/${path}` : `${base}/${path}`);
  }

  getAllPaths(): string[] {
    return [...new Set([...this.knownDirectories, ...this.knownFiles])]
      .filter((path) => !this.isDirectoryMarkerPath(path))
      .sort();
  }

  async chmod(path: string, _mode: number): Promise<void> {
    validatePath(path, "chmod");
    if (!(await this.exists(path))) {
      throw new Error(`ENOENT: no such file or directory, chmod '${path}'`);
    }
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    validatePath(target, "symlink");
    validatePath(linkPath, "symlink");
    throw new Error(`EPERM: operation not permitted, symlink '${target}' -> '${linkPath}'`);
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    validatePath(existingPath, "link");
    validatePath(newPath, "link");
    if (await this.exists(newPath)) {
      throw new Error(`EEXIST: file already exists, link '${newPath}'`);
    }
    await this.cp(existingPath, newPath);
  }

  async readlink(path: string): Promise<string> {
    validatePath(path, "readlink");
    if (!(await this.exists(path))) {
      throw new Error(`ENOENT: no such file or directory, readlink '${path}'`);
    }
    throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
  }

  async lstat(path: string): Promise<FsStat> {
    return this.stat(path);
  }

  async realpath(path: string): Promise<string> {
    validatePath(path, "realpath");
    const normalized = normalizePath(path);
    if (!(await this.exists(normalized))) {
      throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
    }
    return normalized;
  }

  async utimes(path: string, _atime: Date, _mtime: Date): Promise<void> {
    validatePath(path, "utimes");
    if (!(await this.exists(path))) {
      throw new Error(`ENOENT: no such file or directory, utimes '${path}'`);
    }
  }

  async refreshAllPaths(path = "/"): Promise<string[]> {
    validatePath(path, "scandir");
    const normalized = normalizePath(path);
    await this.refreshDirectory(normalized);
    return this.getAllPaths();
  }

  async writeInitialFiles(initialFiles: InitialFiles): Promise<void> {
    for (const [path, value] of Object.entries(initialFiles)) {
      if (typeof value === "function") {
        await this.writeFile(path, await (value as LazyFileProvider)());
      } else if (isFileInit(value)) {
        await this.writeFile(path, value.content);
        if (value.mtime) {
          await this.utimes(path, value.mtime, value.mtime);
        }
        if (value.mode !== undefined) {
          await this.chmod(path, value.mode);
        }
      } else {
        await this.writeFile(path, value);
      }
    }
  }

  private async refreshDirectory(path: string): Promise<void> {
    if (!(await this.directoryExists(path))) return;
    const entries = await this.listDirectory(path, false);
    for (const entry of entries) {
      const child = joinPath(path, entry.name);
      if (entry.type === "directory") {
        await this.refreshDirectory(child);
      }
    }
  }

  private async assertDirectoryReadable(normalized: string, original: string): Promise<void> {
    if (normalized === "/") return;
    if (await this.fileExists(normalized)) {
      throw new Error(`ENOTDIR: not a directory, scandir '${original}'`);
    }
    if (!(await this.directoryExists(normalized))) {
      throw new Error(`ENOENT: no such file or directory, scandir '${original}'`);
    }
  }

  private async assertParentWritable(path: string, operation: string): Promise<void> {
    const parent = dirname(path);
    if (parent === "/") return;
    if (await this.fileExists(parent)) {
      throw new Error(`ENOTDIR: not a directory, ${operation} '${path}'`);
    }
  }

  private async assertParentDirectory(
    path: string,
    operation: string,
    recursive: boolean,
  ): Promise<void> {
    const parent = dirname(path);
    if (parent === "/") return;
    if (await this.fileExists(parent)) {
      throw new Error(`ENOTDIR: not a directory, ${operation} '${path}'`);
    }
    if (!recursive && !(await this.directoryExists(parent))) {
      throw new Error(`ENOENT: no such file or directory, ${operation} '${path}'`);
    }
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await this.op<AgentFsStatResult>("stat", { path });
      this.rememberFile(path);
      return true;
    } catch (err) {
      if (isNotFound(err) || isPathNotFound(err)) return false;
      throw err;
    }
  }

  private async directoryExists(path: string): Promise<boolean> {
    if (path === "/") return true;
    const entries = await this.listDirectory(path, true);
    if (entries.length > 0) {
      this.rememberDirectory(path);
      return true;
    }
    return this.knownDirectories.has(path);
  }

  private async listDirectory(
    path: string,
    includeMarkers: boolean,
  ): Promise<AgentFsLsEntry[]> {
    const result = await this.op<AgentFsLsResult>("ls", { path });
    const entries = includeMarkers
      ? result.entries
      : result.entries.filter((entry) => !this.isDirectoryMarkerName(entry.name));
    for (const entry of result.entries) {
      const child = joinPath(path, entry.name);
      if (entry.type === "directory") {
        this.rememberDirectory(child);
      } else {
        this.rememberFile(child);
      }
    }
    return entries;
  }

  private async collectFilePaths(path: string): Promise<string[]> {
    const files: string[] = [];
    const entries = await this.listDirectory(path, true);
    for (const entry of entries) {
      const child = joinPath(path, entry.name);
      if (entry.type === "directory") {
        files.push(...(await this.collectFilePaths(child)));
      } else {
        files.push(child);
      }
    }
    return files;
  }

  private async op<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.requestJson<T>(
      `/orgs/${encodeURIComponent(this.orgId)}/ops`,
      {
        method: "POST",
        body: JSON.stringify({ op, driveId: this.driveId, ...params }),
      },
    );
  }

  private async requestJson<T>(path: string, init: RequestInit): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Content-Type", "application/json");
    if (this.apiKey) {
      headers.set("Authorization", `Bearer ${this.apiKey}`);
    }

    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, { ...init, headers });
    } catch {
      throw new Error(
        `Cannot connect to agent-fs daemon at ${this.baseUrl}. Is it running? Start with: agent-fs daemon start`,
      );
    }

    const text = await response.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(
        `Unexpected response from daemon (${response.status}): ${text || "empty"}`,
      );
    }

    if (!response.ok) {
      throw httpErrorFromBody(response.status, body);
    }
    return body as T;
  }

  private async getRaw(path: string): Promise<Uint8Array> {
    const headers = new Headers();
    if (this.apiKey) {
      headers.set("Authorization", `Bearer ${this.apiKey}`);
    }

    const response = await this.fetchFn(this.rawUrl(path), {
      method: "GET",
      headers,
    });
    if (!response.ok) {
      throw await httpErrorFromResponse(response);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  private async putRaw(
    path: string,
    bytes: Uint8Array,
    message?: string,
  ): Promise<void> {
    const headers = new Headers();
    headers.set("Content-Type", "application/octet-stream");
    if (this.apiKey) {
      headers.set("Authorization", `Bearer ${this.apiKey}`);
    }
    if (message) {
      headers.set("X-Agent-FS-Message", message);
    }

    const response = await this.fetchFn(this.rawUrl(path), {
      method: "PUT",
      headers,
      body: bytes as BodyInit,
    });
    if (!response.ok) {
      throw await httpErrorFromResponse(response);
    }
  }

  private rawUrl(path: string): string {
    const encoded = path
      .replace(/^\/+/, "")
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
    return `${this.baseUrl}/orgs/${encodeURIComponent(this.orgId)}/drives/${encodeURIComponent(
      this.driveId,
    )}/files/${encoded}/raw`;
  }

  private markerPath(path: string): string {
    return joinPath(path, this.directoryMarkerName);
  }

  private isDirectoryMarkerName(name: string): boolean {
    return name === this.directoryMarkerName;
  }

  private isDirectoryMarkerPath(path: string): boolean {
    return basename(path) === this.directoryMarkerName;
  }

  private messageFor(operation: string, path: string): string | undefined {
    if (typeof this.writeMessage === "function") {
      return this.writeMessage(operation, path);
    }
    return this.writeMessage;
  }

  private rememberFile(path: string): void {
    const normalized = normalizePath(path);
    this.knownFiles.add(normalized);
    this.rememberAncestors(normalized);
  }

  private rememberDirectory(path: string): void {
    const normalized = normalizePath(path);
    this.knownDirectories.add(normalized);
    this.rememberAncestors(normalized);
  }

  private rememberAncestors(path: string): void {
    let current = dirname(path);
    while (true) {
      this.knownDirectories.add(current);
      if (current === "/") break;
      current = dirname(current);
    }
  }

  private forgetFile(path: string): void {
    this.knownFiles.delete(normalizePath(path));
  }

  private forgetDirectory(path: string): void {
    const normalized = normalizePath(path);
    for (const file of [...this.knownFiles]) {
      if (file === normalized || file.startsWith(`${normalized}/`)) {
        this.knownFiles.delete(file);
      }
    }
    for (const dir of [...this.knownDirectories]) {
      if (dir !== "/" && (dir === normalized || dir.startsWith(`${normalized}/`))) {
        this.knownDirectories.delete(dir);
      }
    }
  }
}

export function createAgentFsFileSystem(
  options: AgentFsFileSystemOptions,
): AgentFsFileSystem {
  return new AgentFsFileSystem(options);
}

export async function createAgentFsFileSystemWithFiles(
  options: AgentFsFileSystemOptions,
  initialFiles: InitialFiles,
): Promise<AgentFsFileSystem> {
  const fs = new AgentFsFileSystem(options);
  await fs.writeInitialFiles(initialFiles);
  return fs;
}

export function normalizePath(path: string): string {
  if (!path || path === "/") return "/";
  let normalized = path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path;
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }

  const parts = normalized.split("/").filter((part) => part && part !== ".");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  return `/${resolved.join("/")}` || "/";
}

function validatePath(path: string, operation: string): void {
  if (path.includes("\0")) {
    throw new Error(`ENOENT: path contains null byte, ${operation} '${path}'`);
  }
}

function dirname(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "/";
  const index = normalized.lastIndexOf("/");
  return index === 0 ? "/" : normalized.slice(0, index);
}

function basename(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "/";
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function joinPath(parent: string, child: string): string {
  return normalizePath(parent === "/" ? `/${child}` : `${parent}/${child}`);
}

function getEncoding(
  options?: ReadFileOptions | WriteFileOptions | BufferEncoding,
): BufferEncoding {
  if (typeof options === "string") return options;
  return options?.encoding ?? "utf8";
}

function encodeContent(content: FileContent, encoding: BufferEncoding): Uint8Array {
  if (content instanceof Uint8Array) return content;
  switch (encoding) {
    case "base64":
      return base64ToBytes(content);
    case "hex":
      return hexToBytes(content);
    case "binary":
    case "latin1":
      return latin1ToBytes(content);
    case "ascii":
      return asciiToBytes(content);
    case "utf-8":
    case "utf8":
      return new TextEncoder().encode(content);
  }
}

function decodeBytes(bytes: Uint8Array, encoding: BufferEncoding): string {
  switch (encoding) {
    case "base64":
      return bytesToBase64(bytes);
    case "hex":
      return bytesToHex(bytes);
    case "binary":
    case "latin1":
      return bytesToLatin1(bytes);
    case "ascii":
      return bytesToAscii(bytes);
    case "utf-8":
    case "utf8":
      return new TextDecoder().decode(bytes);
  }
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

function bytesToLatin1(bytes: Uint8Array): string {
  let result = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    result += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return result;
}

function latin1ToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) {
    bytes[i] = value.charCodeAt(i) & 0xff;
  }
  return bytes;
}

function bytesToAscii(bytes: Uint8Array): string {
  let result = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    result += String.fromCharCode(
      ...bytes.subarray(i, i + 0x8000).map((byte) => byte & 0x7f),
    );
  }
  return result;
}

function asciiToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) {
    bytes[i] = value.charCodeAt(i) & 0x7f;
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array {
  if (value.length % 2 !== 0) {
    throw new Error("Invalid hex string length");
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(byte)) {
      throw new Error("Invalid hex string");
    }
    bytes[i] = byte;
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  const binary = bytesToLatin1(bytes);
  if (typeof btoa === "function") return btoa(binary);
  const buffer = getBuffer();
  return buffer.from(binary, "binary").toString("base64");
}

function base64ToBytes(value: string): Uint8Array {
  if (typeof atob === "function") return latin1ToBytes(atob(value));
  const buffer = getBuffer();
  return new Uint8Array(buffer.from(value, "base64"));
}

function getBuffer(): typeof Buffer {
  const maybeBuffer = (globalThis as typeof globalThis & { Buffer?: typeof Buffer })
    .Buffer;
  if (!maybeBuffer) {
    throw new Error("Base64 encoding requires btoa/atob or Buffer");
  }
  return maybeBuffer;
}

function fileStat(result: AgentFsStatResult): FsStat {
  return {
    isFile: true,
    isDirectory: false,
    isSymbolicLink: false,
    mode: DEFAULT_FILE_MODE,
    size: result.size,
    mtime: coerceDate(result.modifiedAt ?? result.createdAt),
  };
}

function directoryStat(): FsStat {
  return {
    isFile: false,
    isDirectory: true,
    isSymbolicLink: false,
    mode: DEFAULT_DIR_MODE,
    size: 0,
    mtime: new Date(),
  };
}

function coerceDate(value: string | Date | undefined): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string") return new Date(value);
  return new Date();
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function getEnv(name: string): string | undefined {
  const processLike = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  return processLike.process?.env?.[name];
}

function isFileInit(value: unknown): value is FileInit {
  return (
    typeof value === "object" &&
    value !== null &&
    "content" in value &&
    !("byteLength" in value)
  );
}

function httpErrorFromBody(status: number, body: any): AgentFsHttpError {
  const message = body?.message ?? body?.error ?? "Request failed";
  const suggestion = body?.suggestion ? `\n  Suggestion: ${body.suggestion}` : "";
  return new AgentFsHttpError(`${message}${suggestion}`, status, body?.error);
}

async function httpErrorFromResponse(response: Response): Promise<AgentFsHttpError> {
  const text = await response.text().catch(() => "");
  try {
    return httpErrorFromBody(response.status, text ? JSON.parse(text) : null);
  } catch {
    return new AgentFsHttpError(
      `Unexpected response from daemon (${response.status}): ${text || "empty"}`,
      response.status,
    );
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof AgentFsHttpError && err.status === 404;
}

function isPathNotFound(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("ENOENT:");
}

function toPathError(err: unknown, operation: string, path: string): Error {
  if (isNotFound(err)) {
    return new Error(`ENOENT: no such file or directory, ${operation} '${path}'`);
  }
  return err instanceof Error ? err : new Error(String(err));
}
