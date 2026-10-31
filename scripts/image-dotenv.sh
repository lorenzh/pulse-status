#!/usr/bin/env bash
# Checks that the image never loads a dotenv file, also not from its healthcheck.
# Usage: bash scripts/image-dotenv.sh <image>
# Each case runs in its own child process with `set -e`; bash ignores `set -e`
# inside `if`, `||` and `&&`, so a case must never run as a function there.
set -uo pipefail

marker="dotenv-marker-556"
fixture=(-e PULSE_API_URL=http://127.0.0.1:9)
expected_cmd='["bun","--no-env-file","src/main.ts"]'

run_control() {
  local image="$1" out code=0
  out="$(timeout 30 docker run --rm "${fixture[@]}" -e "PULSE_LOG_LEVEL=$marker" "$image" 2>&1)" || code=$?
  if [ "$code" -ne 2 ]; then
    echo "control exited $code, expected 2" >&2
    exit 1
  fi
  if ! grep -q 'PULSE_LOG_LEVEL' <<<"$out"; then
    echo "control output does not name PULSE_LOG_LEVEL" >&2
    exit 1
  fi
}

show_container() {
  local c="$1"
  echo "exit code: $(docker inspect --format '{{.State.ExitCode}}' "$c")" >&2
  docker logs --tail 20 "$c" >&2 2>&1 || true
}

run_dotenv() {
  local name="$1" image="$2" state i code healthy=0
  dir="$(mktemp -d)"
  c="pulse-dotenv-$$-${RANDOM}"
  trap 'docker rm -f "$c" >/dev/null 2>&1 || true; rm -rf "$dir"' EXIT
  chmod 0755 "$dir"
  printf 'PULSE_LOG_LEVEL=%s\nPORT=1\n' "$marker" >"$dir/dotenv"
  chmod 0644 "$dir/dotenv"
  docker run -d --name "$c" "${fixture[@]}" -v "$dir/dotenv:/app/$name:ro" "$image" >/dev/null
  mapfile -t health < <(docker image inspect --format '{{json .Config.Healthcheck.Test}}' "$image" | jq -r '.[1:][]')
  for i in $(seq 1 60); do
    state="$(docker inspect --format '{{.State.Running}}' "$c")"
    if [ "$state" != "true" ]; then
      show_container "$c"
      echo "container exited $(docker inspect --format '{{.State.ExitCode}}' "$c")" >&2
      exit 1
    fi
    if docker exec "$c" "${health[@]}" >/dev/null 2>&1; then
      healthy=1
      break
    fi
    sleep 0.5
  done
  if [ "$healthy" -ne 1 ]; then
    show_container "$c"
    echo "healthcheck did not pass within 30 s" >&2
    exit 1
  fi
  docker exec "$c" sh -c "test -r /app/$name && test -s /app/$name"
  if docker logs "$c" 2>&1 | grep -q "$marker"; then
    show_container "$c"
    echo "logs contain the marker" >&2
    exit 1
  fi
  docker stop -t 10 "$c" >/dev/null
  code="$(docker inspect --format '{{.State.ExitCode}}' "$c")"
  if [ "$code" != "0" ]; then
    show_container "$c"
    echo "stop exit code $code, expected 0" >&2
    exit 1
  fi
}

run_image_config() {
  local image="$1" cfg
  cfg="$(docker image inspect "$image" --format '{{json .Config}}')"
  if ! jq -e --argjson cmd "$expected_cmd" '.Cmd == $cmd' <<<"$cfg" >/dev/null; then
    echo "Cmd is $(jq -c '.Cmd' <<<"$cfg")" >&2
    exit 1
  fi
  if ! jq -e '.Healthcheck.Test[0:4] == ["CMD","bun","--no-env-file","-e"]' <<<"$cfg" >/dev/null; then
    echo "Healthcheck is $(jq -c '.Healthcheck.Test[0:4]' <<<"$cfg")" >&2
    exit 1
  fi
}

if [ "${1:-}" = "--case" ]; then
  set -e
  case "$2" in
  control) run_control "$3" ;;
  .env | .env.production | .env.local) run_dotenv "$2" "$3" ;;
  image-config) run_image_config "$3" ;;
  *)
    echo "unknown case $2" >&2
    exit 1
    ;;
  esac
  exit 0
fi

if [ "$#" -ne 1 ]; then
  echo "usage: bash scripts/image-dotenv.sh <image>" >&2
  exit 2
fi

image="$1"
failed=0
for name in control .env .env.production .env.local image-config; do
  errfile="$(mktemp)"
  bash "$0" --case "$name" "$image" 2>"$errfile"
  code=$?
  if [ "$code" -eq 0 ]; then
    echo "ok: $name"
  else
    failed=1
    reason="$(tail -n 1 "$errfile")"
    head -n -1 "$errfile"
    echo "FAIL: $name: ${reason:-exit $code}"
  fi
  rm -f "$errfile"
done
exit "$failed"
