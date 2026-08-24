#!/system/bin/sh
# Manual boot probe executed under run-as (app uid); resolves paths at runtime.
BASE=$(ls -d /data/app/*/dev.dsh.spike* 2>/dev/null | head -1)
echo "BASE=$BASE"
ABI=$(ls "$BASE/lib" 2>/dev/null | head -1)
NLDIR="$BASE/lib/$ABI"
echo "NLDIR=$NLDIR"
cd /data/data/dev.dsh.spike/files/runtime || exit 9
export LD_LIBRARY_PATH="$NLDIR"
export HOME=/data/data/dev.dsh.spike/files
export TMPDIR=/data/data/dev.dsh.spike/cache
export DSH_HOME=/data/data/dev.dsh.spike/files/.dsh
export DSH_AGENTS_HOME=/data/data/dev.dsh.spike/files/.agents
export DSH_PERMISSION_MODE=danger-full-access
export DSH_TELEMETRY_DISABLED=1
export DEEPSEEK_API_KEY=probe-key
export LANG=en_US.UTF-8
exec "$NLDIR/libnode_dsh.so" lib/bin.js web --host 127.0.0.1 --port 3081
