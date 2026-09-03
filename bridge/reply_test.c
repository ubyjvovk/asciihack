/*
 * Unit tests for bridge/reply.c. Cases enumerated in the T-0002 spec:
 *   int ret, negative int, string ret with escapes (\" \\ \n \t), null,
 *   true, selected with two entries, x/y/mod, unknown keys skipped,
 *   garbage line -> parse failure. Run via `make -C bridge test`.
 */
#include "reply.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int g_pass = 0, g_fail = 0;

#define CHECK(cond) do { \
    if (!(cond)) { \
        fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
        g_fail++; return; \
    } \
} while (0)

#define TEST(name) static void name(void)

TEST(t_int_ret)
{
    reply_t r;
    CHECK(reply_parse("{\"id\":7,\"ret\":42}", &r) == 0);
    CHECK(r.has_id && r.id == 7);
    CHECK(r.ret_kind == REPLY_RET_INT && r.ret_int == 42);
    reply_free(&r);
    g_pass++;
}

TEST(t_neg_int_ret)
{
    reply_t r;
    CHECK(reply_parse("{\"id\":1,\"ret\":-1}", &r) == 0);
    CHECK(r.ret_kind == REPLY_RET_INT && r.ret_int == -1);
    reply_free(&r);
    g_pass++;
}

TEST(t_string_ret_escapes)
{
    reply_t r;
    /* JSON: {"id":3,"ret":"a\"b\\c\nd\t"} */
    const char *line = "{\"id\":3,\"ret\":\"a\\\"b\\\\c\\nd\\t\"}";
    CHECK(reply_parse(line, &r) == 0);
    CHECK(r.ret_kind == REPLY_RET_STR);
    CHECK(strcmp(r.ret_str, "a\"b\\c\nd\t") == 0);
    reply_free(&r);
    g_pass++;
}

TEST(t_null_ret)
{
    reply_t r;
    CHECK(reply_parse("{\"id\":9,\"ret\":null}", &r) == 0);
    CHECK(r.ret_kind == REPLY_RET_NULL);
    reply_free(&r);
    g_pass++;
}

TEST(t_true_ret)
{
    reply_t r;
    CHECK(reply_parse("{\"id\":9,\"ret\":true}", &r) == 0);
    CHECK(r.ret_kind == REPLY_RET_BOOL && r.ret_int == 1);
    reply_free(&r);
    g_pass++;
}

TEST(t_false_ret)
{
    reply_t r;
    CHECK(reply_parse("{\"id\":9,\"ret\":false}", &r) == 0);
    CHECK(r.ret_kind == REPLY_RET_BOOL && r.ret_int == 0);
    reply_free(&r);
    g_pass++;
}

TEST(t_selected_two_entries)
{
    reply_t r;
    const char *line = "{\"id\":4,\"ret\":2,"
                       "\"selected\":[{\"i\":0,\"count\":-1},{\"i\":3,\"count\":5}]}";
    CHECK(reply_parse(line, &r) == 0);
    CHECK(r.ret_kind == REPLY_RET_INT && r.ret_int == 2);
    CHECK(r.sel_len == 2);
    CHECK(r.sel[0].i == 0 && r.sel[0].count == -1);
    CHECK(r.sel[1].i == 3 && r.sel[1].count == 5);
    reply_free(&r);
    g_pass++;
}

TEST(t_xymod)
{
    reply_t r;
    const char *line = "{\"id\":11,\"ret\":0,\"x\":12,\"y\":7,\"mod\":1}";
    CHECK(reply_parse(line, &r) == 0);
    CHECK(r.has_x && r.x == 12);
    CHECK(r.has_y && r.y == 7);
    CHECK(r.has_mod && r.mod == 1);
    reply_free(&r);
    g_pass++;
}

TEST(t_unknown_keys_skipped)
{
    reply_t r;
    const char *line = "{\"unknown\":{\"a\":[1,2,{\"b\":\"c}\"}],\"z\":null},"
                       "\"id\":5,\"ret\":\"ok\",\"trailing\":true}";
    CHECK(reply_parse(line, &r) == 0);
    CHECK(r.id == 5);
    CHECK(r.ret_kind == REPLY_RET_STR);
    CHECK(strcmp(r.ret_str, "ok") == 0);
    reply_free(&r);
    g_pass++;
}

TEST(t_garbage_fails)
{
    reply_t r;
    CHECK(reply_parse("this is not json", &r) == -1);
    CHECK(reply_parse("{\"ret\":1}", &r) == -1); /* no id */
    CHECK(reply_parse("{\"id\":1,}", &r) == -1); /* trailing comma */
    CHECK(reply_parse("{\"id\":1,\"ret\":1.5}", &r) == -1); /* float */
    CHECK(reply_parse("{\"id\":1", &r) == -1); /* unterminated */
    g_pass++;
}

int
main(void)
{
    t_int_ret();
    t_neg_int_ret();
    t_string_ret_escapes();
    t_null_ret();
    t_true_ret();
    t_false_ret();
    t_selected_two_entries();
    t_xymod();
    t_unknown_keys_skipped();
    t_garbage_fails();
    fprintf(stderr, "reply_test: %d passed, %d failed\n", g_pass, g_fail);
    return g_fail == 0 ? 0 : 1;
}
