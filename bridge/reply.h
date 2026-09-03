/*
 * Reply parser for the nh-bridge protocol (docs/architecture.md §3.2).
 *
 * The client answers each `call` that carries an `id` with a single-line
 * JSON object. This parser accepts only that reply subset: a flat object
 * whose keys are drawn from `id` (int, required), `ret` (int | JSON string
 * | true | false | null), `selected` (array of {"i":int,"count":int}
 * objects, ints may be negative), and `x`/`y`/`mod` (ints). Unknown keys
 * are skipped. String escapes recognised: \" \\ \/ \n \r \t \b \f and
 * \uXXXX (BMP only, emitted as UTF-8). No nested objects/arrays other than
 * `selected`; no floating-point numbers.
 */
#ifndef NH_BRIDGE_REPLY_H
#define NH_BRIDGE_REPLY_H

#include <stddef.h>

typedef enum {
    REPLY_RET_MISSING = 0,
    REPLY_RET_INT,
    REPLY_RET_STR,
    REPLY_RET_BOOL,
    REPLY_RET_NULL
} reply_ret_kind;

typedef struct {
    long i;
    long count;
} reply_sel_t;

typedef struct {
    int has_id;
    long id;

    reply_ret_kind ret_kind;
    long ret_int;         /* REPLY_RET_INT / REPLY_RET_BOOL (0/1) */
    char *ret_str;        /* REPLY_RET_STR: malloc'd, NUL-terminated */

    int has_x, has_y, has_mod;
    long x, y, mod;

    size_t sel_len;
    reply_sel_t *sel;     /* malloc'd, may be NULL when sel_len == 0 */
} reply_t;

/* Parse one JSON line. Returns 0 on success, -1 on any error (out is
 * left zero-initialised in that case). On success the caller must call
 * reply_free() to release ret_str / sel. The input is not consumed. */
int reply_parse(const char *line, reply_t *out);
void reply_free(reply_t *r);

#endif /* NH_BRIDGE_REPLY_H */
