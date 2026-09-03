#include "reply.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <errno.h>
#include <limits.h>

typedef struct {
    const char *s;
    size_t p;
    size_t len;
} scan_t;

static void
skip_ws(scan_t *sc)
{
    while (sc->p < sc->len) {
        char c = sc->s[sc->p];
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r')
            sc->p++;
        else
            break;
    }
}

static int
peek(scan_t *sc)
{
    return (sc->p < sc->len) ? (unsigned char) sc->s[sc->p] : -1;
}

static int
match_lit(scan_t *sc, const char *lit)
{
    size_t n = strlen(lit);
    if (sc->p + n > sc->len)
        return -1;
    if (memcmp(sc->s + sc->p, lit, n) != 0)
        return -1;
    sc->p += n;
    return 0;
}

/* Parse a signed integer in the range LONG_MIN..LONG_MAX. */
static int
parse_int(scan_t *sc, long *out)
{
    skip_ws(sc);
    size_t start = sc->p;
    if (peek(sc) == '-' || peek(sc) == '+')
        sc->p++;
    if (sc->p >= sc->len || !isdigit((unsigned char) sc->s[sc->p]))
        return -1;
    while (sc->p < sc->len && isdigit((unsigned char) sc->s[sc->p]))
        sc->p++;
    /* Reject floats -- we do not support them. */
    if (sc->p < sc->len) {
        char c = sc->s[sc->p];
        if (c == '.' || c == 'e' || c == 'E')
            return -1;
    }
    char buf[64];
    size_t n = sc->p - start;
    if (n == 0 || n >= sizeof(buf))
        return -1;
    memcpy(buf, sc->s + start, n);
    buf[n] = '\0';
    errno = 0;
    char *end = NULL;
    long v = strtol(buf, &end, 10);
    if (errno != 0 || end == buf || *end != '\0')
        return -1;
    *out = v;
    return 0;
}

/* Emit a codepoint as UTF-8 into buf; returns bytes written (1..4) or -1. */
static int
emit_utf8(unsigned cp, char *buf)
{
    if (cp < 0x80) {
        buf[0] = (char) cp;
        return 1;
    } else if (cp < 0x800) {
        buf[0] = (char) (0xC0 | (cp >> 6));
        buf[1] = (char) (0x80 | (cp & 0x3F));
        return 2;
    } else if (cp < 0x10000) {
        buf[0] = (char) (0xE0 | (cp >> 12));
        buf[1] = (char) (0x80 | ((cp >> 6) & 0x3F));
        buf[2] = (char) (0x80 | (cp & 0x3F));
        return 3;
    } else if (cp < 0x110000) {
        buf[0] = (char) (0xF0 | (cp >> 18));
        buf[1] = (char) (0x80 | ((cp >> 12) & 0x3F));
        buf[2] = (char) (0x80 | ((cp >> 6) & 0x3F));
        buf[3] = (char) (0x80 | (cp & 0x3F));
        return 4;
    }
    return -1;
}

static int
hex_nibble(int c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return 10 + c - 'a';
    if (c >= 'A' && c <= 'F') return 10 + c - 'A';
    return -1;
}

/* Parse a JSON string. On success writes a malloc'd, NUL-terminated
 * UTF-8 string to *out and returns 0. On failure returns -1. */
static int
parse_string(scan_t *sc, char **out)
{
    if (peek(sc) != '"')
        return -1;
    sc->p++;
    size_t cap = 16, len = 0;
    char *buf = (char *) malloc(cap);
    if (!buf)
        return -1;
    while (sc->p < sc->len) {
        unsigned char c = (unsigned char) sc->s[sc->p++];
        if (c == '"') {
            if (len + 1 > cap) {
                char *nb = (char *) realloc(buf, len + 1);
                if (!nb) { free(buf); return -1; }
                buf = nb;
            }
            buf[len] = '\0';
            *out = buf;
            return 0;
        }
        if (c == '\\') {
            if (sc->p >= sc->len)
                goto fail;
            unsigned char e = (unsigned char) sc->s[sc->p++];
            char emit[4];
            int emit_n = 1;
            switch (e) {
            case '"':  emit[0] = '"';  break;
            case '\\': emit[0] = '\\'; break;
            case '/':  emit[0] = '/';  break;
            case 'b':  emit[0] = '\b'; break;
            case 'f':  emit[0] = '\f'; break;
            case 'n':  emit[0] = '\n'; break;
            case 'r':  emit[0] = '\r'; break;
            case 't':  emit[0] = '\t'; break;
            case 'u': {
                if (sc->p + 4 > sc->len)
                    goto fail;
                int h0 = hex_nibble(sc->s[sc->p]);
                int h1 = hex_nibble(sc->s[sc->p + 1]);
                int h2 = hex_nibble(sc->s[sc->p + 2]);
                int h3 = hex_nibble(sc->s[sc->p + 3]);
                if (h0 < 0 || h1 < 0 || h2 < 0 || h3 < 0)
                    goto fail;
                sc->p += 4;
                unsigned cp = (unsigned) ((h0 << 12) | (h1 << 8) | (h2 << 4) | h3);
                /* BMP only; surrogate pairs not supported. */
                if (cp >= 0xD800 && cp <= 0xDFFF)
                    goto fail;
                emit_n = emit_utf8(cp, emit);
                if (emit_n < 0)
                    goto fail;
                break;
            }
            default:
                goto fail;
            }
            if (len + emit_n > cap) {
                while (len + emit_n > cap) cap *= 2;
                char *nb = (char *) realloc(buf, cap);
                if (!nb) { free(buf); return -1; }
                buf = nb;
            }
            memcpy(buf + len, emit, emit_n);
            len += emit_n;
            continue;
        }
        /* Control characters (< 0x20) are not permitted unescaped. */
        if (c < 0x20)
            goto fail;
        if (len + 1 > cap) {
            cap *= 2;
            char *nb = (char *) realloc(buf, cap);
            if (!nb) { free(buf); return -1; }
            buf = nb;
        }
        buf[len++] = (char) c;
    }
fail:
    free(buf);
    return -1;
}

/* Skip one JSON value (object, array, string, number, literal). Used to
 * ignore unknown keys. Returns 0 on success, -1 on parse failure. */
static int
skip_value(scan_t *sc)
{
    skip_ws(sc);
    int c = peek(sc);
    if (c < 0)
        return -1;
    if (c == '"') {
        char *s = NULL;
        if (parse_string(sc, &s) < 0)
            return -1;
        free(s);
        return 0;
    }
    if (c == '{' || c == '[') {
        char open = (char) c;
        char close = (open == '{') ? '}' : ']';
        int depth = 0;
        while (sc->p < sc->len) {
            char cc = sc->s[sc->p];
            if (cc == '"') {
                char *s = NULL;
                if (parse_string(sc, &s) < 0)
                    return -1;
                free(s);
                continue;
            }
            if (cc == open) depth++;
            else if (cc == close) {
                depth--;
                sc->p++;
                if (depth == 0)
                    return 0;
                continue;
            }
            sc->p++;
        }
        return -1;
    }
    if (c == 't') return match_lit(sc, "true");
    if (c == 'f') return match_lit(sc, "false");
    if (c == 'n') return match_lit(sc, "null");
    if (c == '-' || c == '+' || (c >= '0' && c <= '9')) {
        long dummy;
        return parse_int(sc, &dummy);
    }
    return -1;
}

static int
parse_selected(scan_t *sc, reply_t *out)
{
    skip_ws(sc);
    if (peek(sc) != '[')
        return -1;
    sc->p++;
    size_t cap = 0;
    out->sel = NULL;
    out->sel_len = 0;
    skip_ws(sc);
    if (peek(sc) == ']') { sc->p++; return 0; }
    for (;;) {
        skip_ws(sc);
        if (peek(sc) != '{')
            return -1;
        sc->p++;
        long i = 0, count = 0;
        int have_i = 0, have_count = 0;
        skip_ws(sc);
        if (peek(sc) != '}') for (;;) {
            skip_ws(sc);
            char *key = NULL;
            if (parse_string(sc, &key) < 0)
                return -1;
            skip_ws(sc);
            if (peek(sc) != ':') { free(key); return -1; }
            sc->p++;
            if (strcmp(key, "i") == 0) {
                if (parse_int(sc, &i) < 0) { free(key); return -1; }
                have_i = 1;
            } else if (strcmp(key, "count") == 0) {
                if (parse_int(sc, &count) < 0) { free(key); return -1; }
                have_count = 1;
            } else {
                if (skip_value(sc) < 0) { free(key); return -1; }
            }
            free(key);
            skip_ws(sc);
            if (peek(sc) == ',') { sc->p++; continue; }
            if (peek(sc) == '}') break;
            return -1;
        }
        if (peek(sc) != '}')
            return -1;
        sc->p++;
        if (!have_i || !have_count)
            return -1;
        if (out->sel_len + 1 > cap) {
            cap = cap ? cap * 2 : 4;
            reply_sel_t *nb = (reply_sel_t *) realloc(out->sel, cap * sizeof(*nb));
            if (!nb)
                return -1;
            out->sel = nb;
        }
        out->sel[out->sel_len].i = i;
        out->sel[out->sel_len].count = count;
        out->sel_len++;
        skip_ws(sc);
        if (peek(sc) == ',') { sc->p++; continue; }
        if (peek(sc) == ']') { sc->p++; return 0; }
        return -1;
    }
}

static int
parse_ret(scan_t *sc, reply_t *out)
{
    skip_ws(sc);
    int c = peek(sc);
    if (c < 0) return -1;
    if (c == '"') {
        if (parse_string(sc, &out->ret_str) < 0)
            return -1;
        out->ret_kind = REPLY_RET_STR;
        return 0;
    }
    if (c == 't') {
        if (match_lit(sc, "true") < 0) return -1;
        out->ret_kind = REPLY_RET_BOOL;
        out->ret_int = 1;
        return 0;
    }
    if (c == 'f') {
        if (match_lit(sc, "false") < 0) return -1;
        out->ret_kind = REPLY_RET_BOOL;
        out->ret_int = 0;
        return 0;
    }
    if (c == 'n') {
        if (match_lit(sc, "null") < 0) return -1;
        out->ret_kind = REPLY_RET_NULL;
        return 0;
    }
    if (c == '-' || c == '+' || (c >= '0' && c <= '9')) {
        if (parse_int(sc, &out->ret_int) < 0)
            return -1;
        out->ret_kind = REPLY_RET_INT;
        return 0;
    }
    return -1;
}

int
reply_parse(const char *line, reply_t *out)
{
    memset(out, 0, sizeof(*out));
    if (!line)
        return -1;
    scan_t sc = { line, 0, strlen(line) };
    skip_ws(&sc);
    if (peek(&sc) != '{') goto fail;
    sc.p++;
    skip_ws(&sc);
    if (peek(&sc) == '}') { sc.p++; goto check; }
    for (;;) {
        skip_ws(&sc);
        char *key = NULL;
        if (parse_string(&sc, &key) < 0) goto fail;
        skip_ws(&sc);
        if (peek(&sc) != ':') { free(key); goto fail; }
        sc.p++;
        if (strcmp(key, "id") == 0) {
            if (parse_int(&sc, &out->id) < 0) { free(key); goto fail; }
            out->has_id = 1;
        } else if (strcmp(key, "ret") == 0) {
            if (parse_ret(&sc, out) < 0) { free(key); goto fail; }
        } else if (strcmp(key, "selected") == 0) {
            if (parse_selected(&sc, out) < 0) { free(key); goto fail; }
        } else if (strcmp(key, "x") == 0) {
            if (parse_int(&sc, &out->x) < 0) { free(key); goto fail; }
            out->has_x = 1;
        } else if (strcmp(key, "y") == 0) {
            if (parse_int(&sc, &out->y) < 0) { free(key); goto fail; }
            out->has_y = 1;
        } else if (strcmp(key, "mod") == 0) {
            if (parse_int(&sc, &out->mod) < 0) { free(key); goto fail; }
            out->has_mod = 1;
        } else {
            if (skip_value(&sc) < 0) { free(key); goto fail; }
        }
        free(key);
        skip_ws(&sc);
        if (peek(&sc) == ',') { sc.p++; continue; }
        if (peek(&sc) == '}') { sc.p++; break; }
        goto fail;
    }
check:
    skip_ws(&sc);
    if (sc.p != sc.len) goto fail;
    if (!out->has_id) goto fail;
    return 0;
fail:
    reply_free(out);
    memset(out, 0, sizeof(*out));
    return -1;
}

void
reply_free(reply_t *r)
{
    if (!r) return;
    free(r->ret_str);
    free(r->sel);
    r->ret_str = NULL;
    r->sel = NULL;
    r->sel_len = 0;
}
