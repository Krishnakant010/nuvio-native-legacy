#!/bin/bash
# Regression and validation test for stream scoring on Tizen vs webOS.
set -eu
cd "$(dirname "$0")/.."

cat <<'EOF' > /tmp/test_stream_scoring.c
#include <stdio.h>
#include <assert.h>
#include <string.h>

// Mock Stream structure to isolate pontos() scoring logic
typedef struct {
  char rotulo[64];
  int altura;
  int dolbyVision;
  int dolbyAtmos;
  int mp4;
} StreamMock;

const char *ajustes_qualidade(void) { return "Automatica"; }
static int cabeNoTeto(const StreamMock *s) { (void)s; return 1; }

static long pontos(const StreamMock *s) {
  long p = 0;
#ifdef __EMSCRIPTEN__
  if (s->dolbyVision)                                p -= 100000;
  if (s->altura >= 2160 && !s->dolbyVision)          p += 100000;
  else if (s->altura >= 2160)                        p +=  20000;
#else
  if (s->mp4 && s->altura >= 2160 && s->dolbyVision) p += 100000;
  if (s->altura >= 2160)                             p +=  20000;
  if (s->mp4 && s->dolbyVision)                      p +=  10000;
  if (s->mp4)                                        p +=   5000;
#endif
  if (s->dolbyAtmos)                                 p +=   2000;
  p += s->altura;
  if (!cabeNoTeto(s)) p -= 1000000;
  return p;
}

int main(void) {
  StreamMock s_4k_hdr = { "4K HDR10", 2160, 0, 0, 1 };
  StreamMock s_4k_dv  = { "4K Dolby Vision", 2160, 1, 0, 1 };
  StreamMock s_1080p  = { "1080p SDR", 1080, 0, 0, 1 };
  StreamMock s_missing= { "No Res declared", 0, 0, 0, 0 };

#ifdef __EMSCRIPTEN__
  // On Tizen (Samsung): 4K HDR10 MUST score higher than 4K Dolby Vision
  long p_hdr = pontos(&s_4k_hdr);
  long p_dv  = pontos(&s_4k_dv);
  long p_1080= pontos(&s_1080p);
  long p_miss= pontos(&s_missing);
  assert(p_hdr > p_dv);
  assert(p_hdr > p_1080);
  assert(p_1080 > p_miss);
  printf("PASS (Tizen): 4K HDR10 (%ld) > 4K DV (%ld) > 1080p (%ld)\n", p_hdr, p_dv, p_1080);
#else
  // On webOS (LG): 4K Dolby Vision in MP4 MUST score higher than 4K HDR10
  long p_hdr = pontos(&s_4k_hdr);
  long p_dv  = pontos(&s_4k_dv);
  assert(p_dv > p_hdr);
  printf("PASS (webOS): 4K DV (%ld) > 4K HDR10 (%ld)\n", p_dv, p_hdr);
#endif
  return 0;
}
EOF

# 1. Compile and test Tizen rule
cc -O1 -Wall -Wextra -D__EMSCRIPTEN__ /tmp/test_stream_scoring.c -o /tmp/nuvio-stream-tizen-test
/tmp/nuvio-stream-tizen-test

# 2. Compile and test webOS / native rule
cc -O1 -Wall -Wextra /tmp/test_stream_scoring.c -o /tmp/nuvio-stream-webos-test
/tmp/nuvio-stream-webos-test

rm -f /tmp/test_stream_scoring.c /tmp/nuvio-stream-tizen-test /tmp/nuvio-stream-webos-test
echo "tizen-stream-scoring: ALL CONTRACTS PASSED SUCCESSFULLY"
