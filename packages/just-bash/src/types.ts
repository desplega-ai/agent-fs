export type ByteString = string & { readonly __byteStringBrand: unique symbol };

export type BufferEncoding =
  | "utf8"
  | "utf-8"
  | "ascii"
  | "binary"
  | "base64"
  | "hex"
  | "latin1";

export type FileContent = string | Uint8Array;

export interface ReadFileOptions {
  encoding?: BufferEncoding | null;
}

export interface WriteFileOptions {
  encoding?: BufferEncoding;
}

export interface FileEntry {
  type: "file";
  content: string | Uint8Array;
  mode: number;
  mtime: Date;
}

export interface DirectoryEntry {
  type: "directory";
  mode: number;
  mtime: Date;
}

export interface SymlinkEntry {
  type: "symlink";
  target: string;
  mode: number;
  mtime: Date;
}

export interface LazyFileEntry {
  type: "file";
  lazy: () => string | Uint8Array | Promise<string | Uint8Array>;
  mode: number;
  mtime: Date;
}

export type FsEntry =
  | FileEntry
  | LazyFileEntry
  | DirectoryEntry
  | SymlinkEntry;

export interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export interface FsStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mode: number;
  size: number;
  mtime: Date;
}

export interface MkdirOptions {
  recursive?: boolean;
}

export interface RmOptions {
  recursive?: boolean;
  force?: boolean;
}

export interface CpOptions {
  recursive?: boolean;
}

export interface IFileSystem {
  readFile(
    path: string,
    options?: ReadFileOptions | BufferEncoding,
  ): Promise<string>;
  readFileBytes?(path: string): Promise<ByteString>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void>;
  appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FsStat>;
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readdirWithFileTypes?(path: string): Promise<DirentEntry[]>;
  rm(path: string, options?: RmOptions): Promise<void>;
  cp(src: string, dest: string, options?: CpOptions): Promise<void>;
  mv(src: string, dest: string): Promise<void>;
  resolvePath(base: string, path: string): string;
  getAllPaths(): string[];
  chmod(path: string, mode: number): Promise<void>;
  symlink(target: string, linkPath: string): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  readlink(path: string): Promise<string>;
  lstat(path: string): Promise<FsStat>;
  realpath(path: string): Promise<string>;
  utimes(path: string, atime: Date, mtime: Date): Promise<void>;
}

export interface FileInit {
  content: FileContent;
  mode?: number;
  mtime?: Date;
}

export type LazyFileProvider = () =>
  | string
  | Uint8Array
  | Promise<string | Uint8Array>;

export type InitialFiles = Record<
  string,
  FileContent | FileInit | LazyFileProvider
>;

export type FileSystemFactory = (initialFiles?: InitialFiles) => IFileSystem;
