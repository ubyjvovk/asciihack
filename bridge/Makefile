# bridge/Makefile — build nh-bridge and its reply-parser tests.
#
# Not invoked directly by workers; scripts/nethack-build.sh calls
# `make -C bridge nh-bridge` and `make -C bridge test` with LIBDIR /
# OUTDIR set to build/nethack/lib and build/nethack/bridge respectively.
#
# LIBDIR must point at a completed nethack-build.sh lib output
# (libnethack.a, liblua.a, include/, cflags.txt).

REPO       := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/..)
LIBDIR     ?= $(REPO)/build/nethack/lib
OUTDIR     ?= $(REPO)/build/nethack/bridge

# The library was compiled with the exact CFLAGS captured in cflags.txt
# (glyph_info layout depends on them). Reuse them verbatim; add our own
# strict warnings and the include path to the library headers.
NH_CFLAGS  := $(shell cat $(LIBDIR)/cflags.txt)
CFLAGS     ?= -std=gnu99 -O2 -g -Wall -Wextra -Werror
INCLUDES   := -I$(LIBDIR)/include -I.
# hacklib.a supplies the small utility functions (eos, strncmpi, mungspaces,
# ...) that libnethack.a uses but doesn't archive itself. Order matters (the
# linker resolves left-to-right).
LINK_LIBS  := $(LIBDIR)/libnethack.a $(LIBDIR)/libhacklib.a \
              $(LIBDIR)/liblua.a -lm

.PHONY: all nh-bridge test clean

all: nh-bridge

nh-bridge: $(OUTDIR)/nh-bridge

$(OUTDIR)/nh-bridge: nh-bridge.c reply.c reply.h | $(OUTDIR)
	$(CC) $(CFLAGS) $(NH_CFLAGS) $(INCLUDES) \
	    -o $@ nh-bridge.c reply.c $(LINK_LIBS)

$(OUTDIR):
	mkdir -p $(OUTDIR)

# Reply-parser test binary lives out-of-tree so it doesn't clutter bridge/.
test: $(OUTDIR)/reply_test
	$(OUTDIR)/reply_test

$(OUTDIR)/reply_test: reply.c reply.h reply_test.c | $(OUTDIR)
	$(CC) $(CFLAGS) -I. -o $@ reply.c reply_test.c

clean:
	rm -f $(OUTDIR)/nh-bridge $(OUTDIR)/reply_test
