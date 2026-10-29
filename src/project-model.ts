import type { CompilerFamily } from "../scripts/compiler-catalog.mjs";
import type { DevelopmentProfile, ReleaseProfile, ToolProfile } from "./profile-schema.js";
import type { CollectionPin } from "./collection-schema.js";
export interface Project {
  id: string;
  name?: string;
  path: string;
}
export interface LanguageRoot {
  language: string;
  path: string;
  ci_environments?: string[];
  ci_versions?: string[];
  ci_platforms?: string[];
  ci_compatibility?: boolean;
  standard?: string;
  compiler?: CompilerFamily;
  managed_compilers?: Partial<Record<"guix" | "nix", "clang" | "gcc">>;
  lto?: "off" | "thin" | "full";
  compilers?: Partial<Record<CompilerFamily, { minimum: string; ci_versions: string[]; ci_architectures?: string[] }>>;
}
export interface CheckDefinition {
  name: string;
  role: string;
  project?: string;
  path?: string;
  command: string[];
  stages?: string[];
  online?: boolean;
  requires_setup?: boolean;
  environment?: string;
  warn_seconds?: number;
  coverage?: {
    command: string[];
    stages?: string[];
    operating_systems?: string[];
    environments?: string[];
    ci?: {
      operating_systems?: string[];
      environments?: string[];
      architectures?: string[];
      toolchain?: string | false;
    };
  };
}
export interface CheckOrderDefinition {
  root: string;
  after: string;
  phase: "setup" | "complete";
}
export type Config = Record<string, unknown> & {
  collections?: { sources?: CollectionPin[] };
  development?: { default?: string; profiles?: DevelopmentProfile[] };
  toolchains?: { profiles?: ToolProfile[] };
  release?: { profiles?: ReleaseProfile[] };
  tool?: { repository: string; revision: string };
  bundle?: { compression?: "brotli" | "zlib" | "zstd" };
  markdown?: { wrap_width?: number };
  checks?: {
    environment?: string;
    nix_docker_image?: string;
    allow_empty?: boolean;
    pass_environment?: string[];
    environment_files?: string[];
    inputs?: string[];
  };
  ci?: {
    cache?: { artifacts?: Record<string, "cache" | "download"> };
    operating_systems?: string[];
    architectures?: Partial<Record<"linux" | "macos" | "windows", string[]>>;
    environments?: string[];
    toolchains?: string[];
    images?: Partial<Record<"native" | "nix" | "guix", string>>;
  };
  compatibility?: { required?: boolean; data?: "ask" | "migrate" | "delete" };
  check?: CheckDefinition[];
  check_suite?: { language: string; path: string }[];
  check_order?: CheckOrderDefinition[];
};
