#!/usr/bin/env bash
# Downloads the dataset release pinned in config/datasets.json into data/<id>/ for
# local development. Uses your Hugging Face login (hf auth login) and never writes
# the token into the project.
set -euo pipefail

cd "$(dirname "$0")/.."
DATASET="${1:-sediments}"

read -r REPOSITORY REVISION LOCAL_PATH < <(python3 - "$DATASET" <<'PY'
import json, sys
entry = json.load(open("config/datasets.json"))["datasets"][sys.argv[1]]
print(entry["repository"], entry["revision"], entry["localPath"])
PY
)

mkdir -p "$LOCAL_PATH"
uvx --from huggingface_hub hf download "$REPOSITORY" \
  --repo-type dataset \
  --revision "$REVISION" \
  --local-dir "$LOCAL_PATH" \
  --quiet

echo "$REPOSITORY@$REVISION synced into $LOCAL_PATH"
