#!/system/bin/sh
for f in \
  files/runtime/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js \
  files/runtime/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js
do
  if [ -f "$f" ]; then
    n=$(grep -c loadTogglesPatches "$f")
    s=$(wc -c < "$f")
    echo "HIT=$n SIZE=$s  $f"
  else
    echo "ABSENT  $f"
  fi
done
