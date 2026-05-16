#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/leviviya/Documents/Harbor"
DEFAULT_WORKSPACE="$ROOT/.local-workspace/template_new_allcategories_20260512"
DEFAULT_JOBS_ROOT="$ROOT/codex-gpt-5-4-jobs-allcategories-final-pairs"
DEFAULT_MODEL="openai/gpt-5.4"
DEFAULT_CONCURRENCY=20
DEFAULT_ENV_FILE="$ROOT/lstgzl.sh"
DEFAULT_EXPECTED_PAIRS=364
DEFAULT_EXPECTED_WITH=364
DEFAULT_EXPECTED_NO=364

WORKSPACE="$DEFAULT_WORKSPACE"
JOBS_ROOT="$DEFAULT_JOBS_ROOT"
MODEL="$DEFAULT_MODEL"
CONCURRENCY="$DEFAULT_CONCURRENCY"
ENV_FILE="$DEFAULT_ENV_FILE"
EXPECTED_PAIRS="$DEFAULT_EXPECTED_PAIRS"
EXPECTED_WITH="$DEFAULT_EXPECTED_WITH"
EXPECTED_NO="$DEFAULT_EXPECTED_NO"
FORCE_BUILD=1
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: run_allcategories_final_pairs.sh [options]

Options:
  --workspace PATH        Default: /Users/leviviya/Documents/Harbor/.local-workspace/template_new_allcategories_20260512
  --jobs-root PATH        Default: /Users/leviviya/Documents/Harbor/codex-gpt-5-4-jobs-allcategories-final-pairs
  --concurrency N         Default: 20 (shared across with_skill and no_skill)
  --model MODEL           Default: openai/gpt-5.4
  --env-file PATH         Default: /Users/leviviya/Documents/Harbor/lstgzl.sh
  --expected-pairs N      Default: 364
  --expected-with N       Default: 364
  --expected-no N         Default: 364
  --no-force-build        Omit --force-build
  --dry-run               Generate config/manifest only, do not launch Harbor
  -h, --help              Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace)
      WORKSPACE="$2"
      shift 2
      ;;
    --jobs-root)
      JOBS_ROOT="$2"
      shift 2
      ;;
    --concurrency)
      CONCURRENCY="$2"
      shift 2
      ;;
    --model)
      MODEL="$2"
      shift 2
      ;;
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --expected-pairs)
      EXPECTED_PAIRS="$2"
      shift 2
      ;;
    --expected-with)
      EXPECTED_WITH="$2"
      shift 2
      ;;
    --expected-no)
      EXPECTED_NO="$2"
      shift 2
      ;;
    --no-force-build)
      FORCE_BUILD=0
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

RUN_ID="allcategories-final-pairs-codex-gpt54-$(date +%Y%m%d-%H%M%S)-$$"
CONFIG_DIR="$JOBS_ROOT/configs"
JOBS_DIR="$JOBS_ROOT/e2b"
CONFIG_PATH="$CONFIG_DIR/$RUN_ID.json"
MANIFEST_PATH="$CONFIG_DIR/$RUN_ID.manifest.jsonl"

mkdir -p "$CONFIG_DIR" "$JOBS_DIR"

export WORKSPACE CONFIG_PATH MANIFEST_PATH EXPECTED_PAIRS EXPECTED_WITH EXPECTED_NO
"$ROOT/.venv/bin/python3" - <<'PY'
import json
import os
import sys
from pathlib import Path

workspace = Path(os.environ["WORKSPACE"])
config_path = Path(os.environ["CONFIG_PATH"])
manifest_path = Path(os.environ["MANIFEST_PATH"])
expected_pairs = int(os.environ["EXPECTED_PAIRS"])
expected_with = int(os.environ["EXPECTED_WITH"])
expected_no = int(os.environ["EXPECTED_NO"])

required_relpaths = [
    Path("instruction.md"),
    Path("task.toml"),
    Path("environment"),
    Path("tests/test.sh"),
]

patterns = (
    "*/*/final/pf_success/*/*/task1__with_skill/task.toml",
    "*/*/final/oracle_fallback_success/*/*/task1__with_skill/task.toml",
)

tasks = []
manifest_rows = []
pair_roots = []
seen_pairs = set()
missing = []

for pattern in patterns:
    for task_toml in sorted(workspace.glob(pattern)):
        with_skill_dir = task_toml.parent
        task_root = with_skill_dir.parent
        pair_key = str(task_root)
        if pair_key in seen_pairs:
            continue
        seen_pairs.add(pair_key)

        no_skill_dir = task_root / "task1__no_skill"
        absent = []
        for variant_dir in (with_skill_dir, no_skill_dir):
            for relpath in required_relpaths:
                if not (variant_dir / relpath).exists():
                    absent.append({
                        "path": str(variant_dir),
                        "missing": str(relpath),
                    })
                    break
        if absent:
            missing.extend(absent)
            continue

        relative = task_root.relative_to(workspace)
        parts = relative.parts
        if len(parts) != 6:
            missing.append({
                "path": str(task_root),
                "missing": "unexpected path layout",
            })
            continue

        category, subcategory, stage, success_type, template_id, skill = parts
        if stage != "final":
            missing.append({
                "path": str(task_root),
                "missing": f"unexpected stage: {stage}",
            })
            continue

        pair_roots.append(task_root)
        for variant_name, variant_dir in (
            ("task1__with_skill", with_skill_dir),
            ("task1__no_skill", no_skill_dir),
        ):
            tasks.append({
                "path": str(variant_dir),
            })
            manifest_rows.append({
                "index": len(tasks),
                "pair_index": len(pair_roots),
                "stage": stage,
                "category": category,
                "subcategory": subcategory,
                "success_type": success_type,
                "template_id": template_id,
                "skill": skill,
                "variant": variant_name,
                "path": str(variant_dir),
                "pair_path": str(task_root),
            })

errors = []
with_count = sum(1 for row in tasks if row["path"].endswith("task1__with_skill"))
no_count = sum(1 for row in tasks if row["path"].endswith("task1__no_skill"))
variant_count = len(tasks)

if len(pair_roots) != expected_pairs:
    errors.append(f"pairs={len(pair_roots)}, expected={expected_pairs}")
if with_count != expected_with:
    errors.append(f"with_skill={with_count}, expected={expected_with}")
if no_count != expected_no:
    errors.append(f"no_skill={no_count}, expected={expected_no}")
if variant_count != expected_with + expected_no:
    errors.append(f"variants={variant_count}, expected={expected_with + expected_no}")
if missing:
    preview = json.dumps(missing[:20], ensure_ascii=False, indent=2)
    errors.append(f"missing or invalid tasks, first 20:\n{preview}")

if errors:
    print("\n".join(errors), file=sys.stderr)
    sys.exit(1)

config_path.write_text(
    json.dumps({"tasks": tasks}, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
)
with manifest_path.open("w", encoding="utf-8") as fh:
    for row in manifest_rows:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")

print(
    "Prepared task config: "
    f"pairs={len(pair_roots)} with_skill={with_count} "
    f"no_skill={no_count} variants={variant_count}"
)
print(f"CONFIG_PATH={config_path}")
print(f"MANIFEST_PATH={manifest_path}")
PY

echo "RUN_ID=$RUN_ID"
echo "JOB_DIR=$JOBS_DIR/$RUN_ID"
echo "CONFIG_PATH=$CONFIG_PATH"
echo "MANIFEST_PATH=$MANIFEST_PATH"

if [[ "$DRY_RUN" -eq 1 ]]; then
  exit 0
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi

source "$ENV_FILE"

for name in OPENAI_API_KEY OPENAI_BASE_URL E2B_API_KEY; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required environment variable: $name" >&2
    exit 1
  fi
done

harbor_args=(
  "$ROOT/.venv/bin/harbor"
  run
  --config "$CONFIG_PATH"
  -a codex
  -m "$MODEL"
  --ak "api_key=$OPENAI_API_KEY"
  --ak "base_url=$OPENAI_BASE_URL"
  -e e2b
  -n "$CONCURRENCY"
  --jobs-dir "$JOBS_DIR"
  --job-name "$RUN_ID"
)

if [[ "$FORCE_BUILD" -eq 1 ]]; then
  harbor_args+=(--force-build)
fi

"${harbor_args[@]}"
