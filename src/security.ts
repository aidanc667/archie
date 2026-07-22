// src/security.ts
//
// Pure regex scan over raw source text -- deliberately no tree-sitter/AST
// here, unlike magic-number or dangerous-sink detection. A secret-shaped
// string (an AWS key prefix, a PEM header, a suspiciously-named assignment)
// is identifiable from the text alone; this is the same approach real
// secret-scanners (gitleaks/trufflehog) use: line-based regex, not AST.
//
// SAFETY: a SecretFinding is `{ ruleId, line }` and nothing else -- never the
// matched text, a masked preview, or a hash of it. Archie's report is posted
// as a public/org-visible GitHub comment; if a finding ever carried a
// fragment of the real secret, this feature would be the mechanism that
// broadcasts the leak. Do not add a snippet/preview/maskedValue field.

export interface SecretFinding {
  ruleId: string; // e.g. "aws-access-key", "private-key-block", "generic-secret-assignment"
  line: number;
}

// AWS's canonical access-key-id shape: "AKIA" followed by 16 uppercase
// alphanumeric characters. \b on both ends pins the match to exactly this
// length -- without the trailing \b, a longer alphanumeric run containing
// this prefix would still match at 16 characters instead of failing closed.
const AWS_ACCESS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/;

// PEM private-key header line. This alone is unambiguous -- no real-world
// context makes a line starting with this shape anything other than a
// private key -- so, unlike the generic-assignment rule below, it needs no
// exemption list.
const PRIVATE_KEY_BLOCK_RE = /^-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/;

// Matches `<credential-shaped-name> <assign-op> "<quoted value>"` where the
// assignment operator is `=` (TS/JS/Python), `:=` (Go), or a bare `:`
// (TS/Python object- and dict-literal key shape, optionally with the key
// itself quoted, e.g. Python's `"api_key": "..."`). `:=` is checked before
// the bare `[:=]` class so Go's two-character operator is consumed whole
// rather than accidentally splitting on its leading colon.
//
// The leading `\b` requires the credential keyword to start the identifier
// (allowing an optional leading quote for the dict-key-literal case) rather
// than matching anywhere inside it -- this is a deliberate false-negative
// tradeoff (it won't catch a keyword-suffixed compound like `dbPassword`) in
// exchange for not false-positiving on unrelated words that merely contain
// one of these strings as a substring (e.g. "monkey" contains "key").
//
// The value itself must be a quoted string literal of at least 12
// characters -- this is what naturally excludes env-var references like
// `process.env.API_KEY`, `os.environ["API_KEY"]`, or `os.getenv("API_KEY")`:
// none of those have a quoted string literal as the *directly assigned*
// value (the assignment's RHS starts with `process`/`os`, not a quote), so
// this regex simply never matches them -- no special-casing required.
const GENERIC_SECRET_ASSIGNMENT_RE =
  /["']?\b(?:api[_-]?key|secret|token|password|passwd)\w*["']?\s*(?::=|[:=])\s*(["'])((?:(?!\1)[^\r\n]){12,})\1/i;

// Case-insensitive substrings that mark a value as an obvious placeholder
// rather than a real secret -- these are documentation/example conventions,
// not leaked credentials, so flagging them would just be noise.
const PLACEHOLDER_SUBSTRINGS = [
  "changeme",
  "example",
  "placeholder",
  "xxx",
  "todo",
  "fixme",
  "redacted",
  "<your",
  "${",
  "{{",
];

// A value made of one character repeated (e.g. "xxxxxxxxxxxx" or
// "aaaaaaaaaaaa") is filler, not a secret -- real credentials aren't
// constant runs of a single character.
function isAllSameCharacter(value: string): boolean {
  return value.length > 0 && new Set(value).size === 1;
}

function isPlaceholderSecretValue(value: string): boolean {
  if (value.length === 0) return true;
  const lower = value.toLowerCase();
  if (PLACEHOLDER_SUBSTRINGS.some((placeholder) => lower.includes(placeholder))) {
    return true;
  }
  return isAllSameCharacter(value);
}

export function detectHardcodedSecrets(source: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = source.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;

    if (AWS_ACCESS_KEY_RE.test(line)) {
      findings.push({ ruleId: "aws-access-key", line: lineNumber });
    }

    if (PRIVATE_KEY_BLOCK_RE.test(line)) {
      findings.push({ ruleId: "private-key-block", line: lineNumber });
    }

    const genericMatch = line.match(GENERIC_SECRET_ASSIGNMENT_RE);
    if (genericMatch && !isPlaceholderSecretValue(genericMatch[2])) {
      findings.push({ ruleId: "generic-secret-assignment", line: lineNumber });
    }
  }

  return findings;
}
