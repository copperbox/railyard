# Filter grammar (Contract v1)

SPEC §3. An agent subscription may carry a declarative **filter** that decides, per signal,
whether the agent fires. Filters are the routing contract's only expressiveness knob, and
they are deliberately tiny: **there is no escape hatch into code**, by design. If a filter
can't express what you need, write a smarter monitor.

## Grammar

```
<filter> ::= <jsonpath> <op> <json-literal>
<op>     ::= "==" | "!="
```

- **`<jsonpath>`** must start with `$` and is a standard JSONPath expression evaluated
  against the signal **payload** (not the full envelope). Script/eval expressions are
  disabled — a filter can select and compare, never compute.
- **`<json-literal>`** is a single JSON value: quote strings (`"needs-review"`), and write
  numbers/booleans/null bare. An unquoted bareword is a parse error (it isn't valid JSON).

Examples:

```yaml
filter: '$.label.name == "needs-review"'   # shape-A github.issue.* label match
filter: '$.issue.state != "closed"'
filter: '$.issue.number == 42'
```

## Semantics

- The JSONPath resolves to a **set** of matched values.
- **`==`** is true when **at least one** matched value structurally equals the literal
  (deep equality).
- **`!=`** is the exact negation of `==`. Consequently a path that matches nothing
  satisfies `!=` (there is no matched value equal to the literal) and fails `==`.
- Array-wildcard paths compose naturally: `$.issue.labels[*] == "bug"` is true when any
  current label name is `bug`.

## Boot-time validation

A malformed filter — bad operator, a path not starting with `$`, a non-JSON comparand, or
invalid JSONPath syntax — **fails at boot** (invariant 4), with a message naming the agent
and the offending filter. A dry-run resolution against an empty payload happens at load
time so syntax errors surface before `start()` resolves, never mid-run.

## For port authors

Parse into `{ path, op, literal }`, dry-run the path at load, and evaluate as
"any matched value deep-equals the literal, negated for `!=`". Keep script evaluation
disabled — the declarative ceiling is a contract, not an implementation detail.

Related: [Signal Contract v1 index](./README.md), [signal
envelope](./signal-envelope.md), [`github.issue.*` payloads](./github-issue-signals.md).
