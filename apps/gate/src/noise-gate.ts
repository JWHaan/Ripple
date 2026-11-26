/**
 * Stage 1 — deterministic noise gate. No network, no LLM, no randomness: the same diff
 * always yields the same DiffSummary.
 *
 * Detectors:
 *   D1  schema / migration files        (path)
 *   D2  API contract specifications     (path)
 *   D3  auth, token and session code    (path)
 *   D4  config / environment contracts  (path)
 *   D5  shared library public surface   (path)
 *   D6  contract-level content signals  (changed lines, all files):
 *         D6a destructive SQL, D6b removed API contract elements, D6c token/claim shape
 *
 * A diff with zero findings has no blast radius and never leaves Gate.
 */
import {
  MAX_EXCERPT_CHARS,
  MAX_FINDINGS,
  type DiffSummary,
  type Severity,
  type SurfaceFinding,
  type SurfaceKind,
} from '@ripple/contracts';

export interface FileChange {
  readonly path: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

const SEVERITY_RANK: Record<Severity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

/** Splits a unified diff into per-file added/removed lines. Binary hunks carry no lines. */
export function parseUnifiedDiff(diff: string): FileChange[] {
  const files: { path: string; added: string[]; removed: string[] }[] = [];
  let current: { path: string; added: string[]; removed: string[] } | null = null;
  for (const line of diff.split('\n')) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header !== null) {
      current = { path: header[2] ?? header[1] ?? '', added: [], removed: [] };
      files.push(current);
      continue;
    }
    if (current === null) continue;
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (line.startsWith('+')) current.added.push(line.slice(1));
    else if (line.startsWith('-')) current.removed.push(line.slice(1));
  }
  return files;
}

// --- noise filters ---------------------------------------------------------

const IGNORED_PATH = [
  /(^|\/)(__tests__|__mocks__|tests?|spec|specs|fixtures|testdata|docs?|examples?)\//i,
  /\.(test|spec)\.[a-z]+$/i,
  /_test\.(go|py|rb)$/i,
  /\.(md|mdx|txt|rst|snap|png|jpe?g|gif|svg|ico|lock)$/i,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|CHANGELOG[^/]*|LICENSE[^/]*)$/i,
];

const COMMENT_OR_BLANK = /^\s*($|\/\/|#|--|\/\*|\*|<!--)/;

function isSubstantive(lines: readonly string[]): boolean {
  return lines.some((line) => !COMMENT_OR_BLANK.test(line));
}

// --- D1–D5: path detectors -------------------------------------------------

interface PathRule {
  readonly id: string;
  readonly kind: SurfaceKind;
  readonly severity: Severity;
  readonly label: string;
  readonly patterns: readonly RegExp[];
}

const PATH_RULES: readonly PathRule[] = [
  {
    id: 'D1.schema-migration',
    kind: 'SCHEMA_MIGRATION',
    severity: 'HIGH',
    label: 'Database schema or migration',
    patterns: [
      /(^|\/)(migrations?|db\/migrate|alembic\/versions|flyway|liquibase)\/.+/i,
      /(^|\/)schema\.(prisma|sql|rb|graphqls?)$/i,
      /\.sql$/i,
    ],
  },
  {
    id: 'D2.api-contract',
    kind: 'API_CONTRACT',
    severity: 'HIGH',
    label: 'API contract specification',
    patterns: [/(^|\/)[^/]*(openapi|swagger)[^/]*\.(ya?ml|json)$/i, /\.(graphql|gql|proto|avsc|thrift)$/i],
  },
  {
    id: 'D3.auth-token',
    kind: 'AUTH_TOKEN',
    severity: 'HIGH',
    label: 'Authentication, token or session code',
    patterns: [/(^|\/)(auth|authn|authz|oauth2?|sessions?|tokens?|jwt|security|identity)(\/|[._-])/i],
  },
  {
    id: 'D4.config-contract',
    kind: 'CONFIG_CONTRACT',
    severity: 'MEDIUM',
    label: 'Configuration or environment contract',
    patterns: [
      /(^|\/)\.env\.(example|sample|template|defaults)$/i,
      /(^|\/)config\/.+\.(json|ya?ml|toml)$/i,
      /(^|\/)(helm|charts)\/.+values[^/]*\.ya?ml$/i,
    ],
  },
  {
    id: 'D5.shared-library',
    kind: 'SHARED_LIBRARY',
    severity: 'MEDIUM',
    label: 'Shared library public surface',
    patterns: [
      /(^|\/)(shared|common|sdk|contracts|idl)\/.+\.[a-z]+$/i,
      /(^|\/)(libs?|packages)\/[^/]+\/(src\/)?index\.[a-z]+$/i,
    ],
  },
];

// --- D6: content detectors -------------------------------------------------

const DESTRUCTIVE_SQL =
  /\b(DROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT)|ALTER\s+TABLE\s+\S+\s+(DROP|RENAME|ALTER\s+COLUMN)|RENAME\s+(TABLE|COLUMN)|TRUNCATE\s+TABLE)\b/i;

/** Lines that declare a contract element, with the element's identifier in group 1. */
const CONTRACT_ELEMENT: readonly RegExp[] = [
  /^\s{0,4}(\/[\w{}./-]+):\s*$/, // OpenAPI path
  /^\s*"(\/[\w{}./-]+)"\s*:/, // OpenAPI path (JSON)
  /^\s*rpc\s+(\w+)\s*\(/, // protobuf rpc
  /^\s*(?:repeated\s+|optional\s+|required\s+)?[\w.]+\s+(\w+)\s*=\s*\d+\s*[;[]/, // protobuf field
  /^\s*(\w+)\s*(?:\([^)]*\))?\s*:\s*\[?\w+!?\]?!?\s*$/, // GraphQL field
];

const TOKEN_SHAPE =
  /\b(jwt\.(sign|verify|decode)|jsonwebtoken|jose\b|claims?\b|expiresIn|token_?type|access_?token|refresh_?token|audience\b|issuer\b|set-?cookie|session\.(cookie|secret)|signing_?key)/i;

const CONTRACT_FILE = PATH_RULES[1]?.patterns ?? [];

function removedContractElements(file: FileChange): string[] {
  const identify = (line: string): string | null => {
    for (const pattern of CONTRACT_ELEMENT) {
      const match = pattern.exec(line);
      if (match?.[1] !== undefined) return match[1];
    }
    return null;
  };
  const stillPresent = new Set(file.added.map(identify).filter((id): id is string => id !== null));
  const removed = file.removed.map(identify).filter((id): id is string => id !== null);
  return [...new Set(removed.filter((id) => !stillPresent.has(id)))];
}

// --- assembly --------------------------------------------------------------

const SECRET_ASSIGNMENT = /^(\s*[\w.-]*(?:key|secret|token|password|passwd|credential)[\w.-]*\s*[=:]\s*)(\S.*)$/i;

function excerptOf(file: FileChange, prefer: RegExp | null): string {
  const tag = (sign: string, lines: readonly string[]) =>
    lines.map((line) => `${sign}${line.replace(SECRET_ASSIGNMENT, '$1<redacted>')}`);
  const all = [...tag('-', file.removed), ...tag('+', file.added)];
  const chosen = prefer === null ? all : [...all.filter((l) => prefer.test(l)), ...all.filter((l) => !prefer.test(l))];
  const text = chosen.join('\n');
  return text.length <= MAX_EXCERPT_CHARS ? text : `${text.slice(0, MAX_EXCERPT_CHARS - 1)}…`;
}

function finding(
  file: FileChange,
  ruleId: string,
  kind: SurfaceKind,
  method: SurfaceFinding['method'],
  severity: Severity,
  statement: string,
  prefer: RegExp | null,
): SurfaceFinding {
  return { ruleId, kind, method, severity, filePath: file.path, statement, excerpt: excerptOf(file, prefer), breaking: null };
}

function detect(file: FileChange): SurfaceFinding[] {
  if (IGNORED_PATH.some((pattern) => pattern.test(file.path))) return [];
  const changed = [...file.added, ...file.removed];
  if (!isSubstantive(changed)) return [];

  const counts = `(+${file.added.length} −${file.removed.length})`;
  const findings: SurfaceFinding[] = [];

  for (const rule of PATH_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(file.path))) {
      findings.push(
        finding(file, rule.id, rule.kind, 'PATH_PATTERN', rule.severity, `${rule.label} changed: ${file.path} ${counts}`, null),
      );
    }
  }

  if (file.added.some((line) => !COMMENT_OR_BLANK.test(line) && DESTRUCTIVE_SQL.test(line))) {
    findings.push(
      finding(file, 'D6a.destructive-sql', 'SCHEMA_MIGRATION', 'CONTENT_PATTERN', 'CRITICAL',
        `Destructive schema statement added in ${file.path}`, DESTRUCTIVE_SQL),
    );
  }

  if (CONTRACT_FILE.some((pattern) => pattern.test(file.path))) {
    const removed = removedContractElements(file);
    if (removed.length > 0) {
      const shown = removed.slice(0, 5).join(', ');
      const more = removed.length > 5 ? ` and ${removed.length - 5} more` : '';
      findings.push(
        finding(file, 'D6b.contract-element-removed', 'API_CONTRACT', 'CONTENT_PATTERN', 'CRITICAL',
          `Contract element(s) removed from ${file.path}: ${shown}${more}`, null),
      );
    }
  }

  if (changed.some((line) => !COMMENT_OR_BLANK.test(line) && TOKEN_SHAPE.test(line))) {
    findings.push(
      finding(file, 'D6c.token-shape', 'AUTH_TOKEN', 'CONTENT_PATTERN', 'HIGH',
        `Token, claim or session handling changed in ${file.path} ${counts}`, TOKEN_SHAPE),
    );
  }

  // One finding per (file, kind): keep the most severe.
  const strongest = new Map<SurfaceKind, SurfaceFinding>();
  for (const candidate of findings) {
    const existing = strongest.get(candidate.kind);
    if (existing === undefined || SEVERITY_RANK[candidate.severity] > SEVERITY_RANK[existing.severity]) {
      strongest.set(candidate.kind, candidate);
    }
  }
  return [...strongest.values()];
}

export function classifyFiles(files: readonly FileChange[], inputTruncated = false): DiffSummary {
  const all = files
    .flatMap(detect)
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.filePath.localeCompare(b.filePath));
  return {
    filesChanged: files.length,
    linesAdded: files.reduce((sum, file) => sum + file.added.length, 0),
    linesRemoved: files.reduce((sum, file) => sum + file.removed.length, 0),
    findings: all.slice(0, MAX_FINDINGS),
    truncated: inputTruncated || all.length > MAX_FINDINGS,
  };
}

export function classifyDiff(diff: string, inputTruncated = false): DiffSummary {
  return classifyFiles(parseUnifiedDiff(diff), inputTruncated);
}
