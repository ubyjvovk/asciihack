/*
 * nh-bridge.c — turn NetHack's SHIM_GRAPHICS window port into a JSON-lines
 * protocol on stdin/stdout. See docs/architecture.md §3 for the full contract.
 *
 * Startup:
 *   1. print `hello` (proto/version + S/cmap/nhw/bl/pick/atr/mg/clr/blmask
 *      tables + extra.extcmds);
 *   2. install atexit hook + shim callback;
 *   3. return nhmain(argc, argv), then print `exit`.
 *
 * Each shim_* call becomes one JSON object on stdout. Calls that need a
 * return value carry an `id` and block reading one reply line on stdin.
 * On stdin EOF / parse failure while waiting for a reply, print `exit` with
 * a `reason` and exit 2 within milliseconds.
 */

#include "hack.h"
#include "func_tab.h"
#include "dlb.h"
#include "sym.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <unistd.h>
#include <errno.h>
#include <ctype.h>

#include "reply.h"

typedef void (*shim_callback_t)(const char *name, void *ret_ptr,
                                const char *fmt, ...);
extern void shim_graphics_set_callback(shim_callback_t cb);
extern int nhmain(int argc, char **argv);
extern int glyph_to_cmap(int);

/* ------------------------------------------------------------------------ */
/* Global state (single-threaded — one outstanding request at a time). */

static long g_next_id = 1;
static int g_exit_printed = 0;

/* Menu bookkeeping. Key by winid; NetHack rarely uses more than a handful. */
#define MAX_WIN 128
typedef struct {
    anything *items;
    size_t len, cap;
} win_menu_t;
static win_menu_t g_menus[MAX_WIN];

static void
menu_reset(winid w)
{
    if (w >= 0 && w < MAX_WIN)
        g_menus[w].len = 0;
}

/* Append an identifier and return its 0-based index, or −1 if the
 * identifier is all-zero (unselectable header per the spec). */
static long
menu_append(winid w, const anything *ident)
{
    if (w < 0 || w >= MAX_WIN)
        return -1;
    static const anything zero;
    if (!ident || memcmp(ident, &zero, sizeof(zero)) == 0)
        return -1;
    win_menu_t *m = &g_menus[w];
    if (m->len + 1 > m->cap) {
        size_t nc = m->cap ? m->cap * 2 : 16;
        anything *nb = (anything *) realloc(m->items, nc * sizeof(*nb));
        if (!nb) return -1;
        m->items = nb;
        m->cap = nc;
    }
    m->items[m->len] = *ident;
    return (long) m->len++;
}

/* ------------------------------------------------------------------------ */
/* JSON writer helpers. */

static void
json_str(const char *s)
{
    fputc('"', stdout);
    if (s) {
        for (const unsigned char *p = (const unsigned char *) s; *p; p++) {
            unsigned char c = *p;
            if (c == '"') fputs("\\\"", stdout);
            else if (c == '\\') fputs("\\\\", stdout);
            else if (c < 0x20 || c >= 0x80) fprintf(stdout, "\\u%04x", (unsigned) c);
            else fputc((int) c, stdout);
        }
    }
    fputc('"', stdout);
}

static void
json_str_or_null(const char *s)
{
    if (!s) fputs("null", stdout);
    else json_str(s);
}

static void
print_exit(int code, const char *reason)
{
    if (g_exit_printed) return;
    g_exit_printed = 1;
    fputs("{\"t\":\"exit\",\"code\":", stdout);
    fprintf(stdout, "%d", code);
    if (reason) {
        fputs(",\"reason\":", stdout);
        json_str(reason);
    }
    fputs("}\n", stdout);
    fflush(stdout);
}

static void
print_log(const char *msg)
{
    fputs("{\"t\":\"log\",\"msg\":", stdout);
    json_str(msg);
    fputs("}\n", stdout);
}

static void die_reason(const char *reason);
static void
die_reason(const char *reason)
{
    print_exit(2, reason);
    fflush(stdout);
    exit(2);
}

/* Read one \n-terminated line from stdin (excluding the \n). NULL on EOF. */
static char *
read_line(void)
{
    size_t cap = 512, len = 0;
    char *buf = (char *) malloc(cap);
    if (!buf) return NULL;
    for (;;) {
        int c = fgetc(stdin);
        if (c == EOF) {
            if (len == 0) { free(buf); return NULL; }
            break;
        }
        if (c == '\n') break;
        if (len + 1 >= cap) {
            cap *= 2;
            char *nb = (char *) realloc(buf, cap);
            if (!nb) { free(buf); return NULL; }
            buf = nb;
        }
        buf[len++] = (char) c;
    }
    buf[len] = '\0';
    return buf;
}

/* Finish the current call line with an id, flush, wait for one reply. */
static long
finish_and_wait(reply_t *out)
{
    long id = g_next_id++;
    fprintf(stdout, ",\"id\":%ld}\n", id);
    fflush(stdout);
    char *line = read_line();
    if (!line)
        die_reason("stdin EOF while awaiting reply");
    if (reply_parse(line, out) < 0) {
        print_log("reply parse failed");
        free(line);
        die_reason("reply parse failed");
    }
    free(line);
    if (!out->has_id || out->id != id) {
        reply_free(out);
        die_reason("reply id mismatch");
    }
    return id;
}

/* ------------------------------------------------------------------------ */
/* Glyph classification and idx. */

static const char *
glyph_cls(int glyph)
{
    if (glyph_is_unexplored(glyph))       return "unexplored";
    if (glyph_is_nothing(glyph))          return "nothing";
    if (glyph_is_pet(glyph))              return "pet";
    if (glyph_is_ridden_monster(glyph))   return "ridden";
    if (glyph_is_detected_monster(glyph)) return "detected";
    if (glyph_is_invisible(glyph))        return "invisible";
    if (glyph_is_body(glyph))             return "body";
    if (glyph_is_statue(glyph))           return "statue";
    if (glyph_is_monster(glyph))          return "mon";
    if (glyph_is_trap(glyph))             return "trap";
    if (glyph_is_cmap(glyph))             return "cmap";
    if (glyph_is_object(glyph))           return "obj";
    if (glyph_is_warning(glyph))          return "warning";
    if (glyph_is_swallow(glyph))          return "swallow";
    if (glyph_is_explosion(glyph))        return "explosion";
    return "other";
}

static int
glyph_idx(int glyph, const char *cls)
{
    if (!strcmp(cls, "cmap"))         return glyph_to_cmap(glyph);
    if (!strcmp(cls, "mon")
     || !strcmp(cls, "pet")
     || !strcmp(cls, "ridden")
     || !strcmp(cls, "detected"))     return glyph_to_mon(glyph);
    if (!strcmp(cls, "obj")
     || !strcmp(cls, "body")
     || !strcmp(cls, "statue"))       return glyph_to_obj(glyph);
    if (!strcmp(cls, "trap"))         return glyph_to_trap(glyph);
    if (!strcmp(cls, "warning"))      return glyph_to_warning(glyph);
    return 0;
}

static void
emit_glyph_info(const glyph_info *g)
{
    if (!g) { fputs("null", stdout); return; }
    const char *cls = glyph_cls(g->glyph);
    int idx = glyph_idx(g->glyph, cls);
    fprintf(stdout, "{\"glyph\":%d,\"ch\":", g->glyph);
    char chbuf[2] = { (char) g->ttychar, '\0' };
    json_str(chbuf);
    fprintf(stdout, ",\"color\":%d,\"cls\":", g->gm.sym.color);
    json_str(cls);
    fprintf(stdout, ",\"idx\":%d,\"flags\":%u}",
            idx, (unsigned) g->gm.glyphflags);
}

/* ------------------------------------------------------------------------ */
/* Hello. Tables generated from defsym.h + hand-written constant lists.    */

/* Iterate defsym.h in DUMP_ENUMS_PCHAR mode to build { idx, "S_name" } pairs. */
struct s_row { int idx; const char *name; };
static const struct s_row S_TABLE[] = {
#define DUMP_ENUMS_PCHAR
#include "defsym.h"
#undef DUMP_ENUMS_PCHAR
    { 0, NULL }
};

/* Every other name table is small enough to spell out. */
struct name_int { const char *name; int val; };
struct name_ulong { const char *name; unsigned long val; };

static const struct name_int NHW_TABLE[] = {
    { "NHW_MESSAGE", NHW_MESSAGE }, { "NHW_STATUS", NHW_STATUS },
    { "NHW_MAP", NHW_MAP }, { "NHW_MENU", NHW_MENU },
    { "NHW_TEXT", NHW_TEXT }, { "NHW_PERMINVENT", NHW_PERMINVENT },
    { NULL, 0 }
};

static const struct name_int BL_TABLE[] = {
    { "BL_CHARACTERISTICS", BL_CHARACTERISTICS },
    { "BL_RESET", BL_RESET }, { "BL_FLUSH", BL_FLUSH },
    { "BL_TITLE", BL_TITLE },
    { "BL_STR", BL_STR }, { "BL_DX", BL_DX }, { "BL_CO", BL_CO },
    { "BL_IN", BL_IN }, { "BL_WI", BL_WI }, { "BL_CH", BL_CH },
    { "BL_ALIGN", BL_ALIGN }, { "BL_SCORE", BL_SCORE },
    { "BL_CAP", BL_CAP }, { "BL_GOLD", BL_GOLD },
    { "BL_ENE", BL_ENE }, { "BL_ENEMAX", BL_ENEMAX },
    { "BL_XP", BL_XP }, { "BL_AC", BL_AC }, { "BL_HD", BL_HD },
    { "BL_TIME", BL_TIME }, { "BL_HUNGER", BL_HUNGER },
    { "BL_HP", BL_HP }, { "BL_HPMAX", BL_HPMAX },
    { "BL_LEVELDESC", BL_LEVELDESC }, { "BL_EXP", BL_EXP },
    { "BL_CONDITION", BL_CONDITION },
    { "BL_WEAPON", BL_WEAPON }, { "BL_ARMOR", BL_ARMOR },
    { "BL_TERRAIN", BL_TERRAIN }, { "BL_VERS", BL_VERS },
    { "MAXBLSTATS", MAXBLSTATS },
    { NULL, 0 }
};

static const struct name_int PICK_TABLE[] = {
    { "PICK_NONE", PICK_NONE }, { "PICK_ONE", PICK_ONE },
    { "PICK_ANY", PICK_ANY }, { NULL, 0 }
};

static const struct name_int ATR_TABLE[] = {
    { "ATR_NONE", ATR_NONE }, { "ATR_BOLD", ATR_BOLD },
    { "ATR_DIM", ATR_DIM }, { "ATR_ITALIC", ATR_ITALIC },
    { "ATR_ULINE", ATR_ULINE }, { "ATR_BLINK", ATR_BLINK },
    { "ATR_INVERSE", ATR_INVERSE },
    { "ATR_URGENT", ATR_URGENT }, { "ATR_NOHISTORY", ATR_NOHISTORY },
    { NULL, 0 }
};

static const struct name_int MG_TABLE[] = {
    { "MG_HERO", MG_HERO }, { "MG_CORPSE", MG_CORPSE },
    { "MG_INVIS", MG_INVIS }, { "MG_DETECT", MG_DETECT },
    { "MG_PET", MG_PET }, { "MG_RIDDEN", MG_RIDDEN },
    { "MG_STATUE", MG_STATUE }, { "MG_OBJPILE", MG_OBJPILE },
    { "MG_BW_LAVA", MG_BW_LAVA }, { "MG_BW_ICE", MG_BW_ICE },
    { "MG_BW_SINK", MG_BW_SINK }, { "MG_BW_ENGR", MG_BW_ENGR },
    { "MG_NOTHING", MG_NOTHING }, { "MG_UNEXPL", MG_UNEXPL },
    { "MG_MALE", MG_MALE }, { "MG_FEMALE", MG_FEMALE },
    { "MG_BADXY", MG_BADXY },
    { NULL, 0 }
};

static const struct name_int CLR_TABLE[] = {
    { "CLR_BLACK", CLR_BLACK }, { "CLR_RED", CLR_RED },
    { "CLR_GREEN", CLR_GREEN }, { "CLR_BROWN", CLR_BROWN },
    { "CLR_BLUE", CLR_BLUE }, { "CLR_MAGENTA", CLR_MAGENTA },
    { "CLR_CYAN", CLR_CYAN }, { "CLR_GRAY", CLR_GRAY },
    { "NO_COLOR", NO_COLOR }, { "CLR_ORANGE", CLR_ORANGE },
    { "CLR_BRIGHT_GREEN", CLR_BRIGHT_GREEN }, { "CLR_YELLOW", CLR_YELLOW },
    { "CLR_BRIGHT_BLUE", CLR_BRIGHT_BLUE },
    { "CLR_BRIGHT_MAGENTA", CLR_BRIGHT_MAGENTA },
    { "CLR_BRIGHT_CYAN", CLR_BRIGHT_CYAN }, { "CLR_WHITE", CLR_WHITE },
    { NULL, 0 }
};

static const struct name_ulong BLMASK_TABLE[] = {
    { "BL_MASK_BAREH", BL_MASK_BAREH }, { "BL_MASK_BLIND", BL_MASK_BLIND },
    { "BL_MASK_BUSY", BL_MASK_BUSY }, { "BL_MASK_CONF", BL_MASK_CONF },
    { "BL_MASK_DEAF", BL_MASK_DEAF }, { "BL_MASK_ELF_IRON", BL_MASK_ELF_IRON },
    { "BL_MASK_FLY", BL_MASK_FLY }, { "BL_MASK_FOODPOIS", BL_MASK_FOODPOIS },
    { "BL_MASK_GLOWHANDS", BL_MASK_GLOWHANDS },
    { "BL_MASK_GRAB", BL_MASK_GRAB }, { "BL_MASK_HALLU", BL_MASK_HALLU },
    { "BL_MASK_HELD", BL_MASK_HELD }, { "BL_MASK_ICY", BL_MASK_ICY },
    { "BL_MASK_INLAVA", BL_MASK_INLAVA }, { "BL_MASK_LEV", BL_MASK_LEV },
    { "BL_MASK_PARLYZ", BL_MASK_PARLYZ }, { "BL_MASK_RIDE", BL_MASK_RIDE },
    { "BL_MASK_SLEEPING", BL_MASK_SLEEPING },
    { "BL_MASK_SLIME", BL_MASK_SLIME }, { "BL_MASK_SLIPPERY", BL_MASK_SLIPPERY },
    { "BL_MASK_STONE", BL_MASK_STONE }, { "BL_MASK_STRNGL", BL_MASK_STRNGL },
    { "BL_MASK_STUN", BL_MASK_STUN }, { "BL_MASK_SUBMERGED", BL_MASK_SUBMERGED },
    { "BL_MASK_TERMILL", BL_MASK_TERMILL },
    { "BL_MASK_TETHERED", BL_MASK_TETHERED },
    { "BL_MASK_TRAPPED", BL_MASK_TRAPPED }, { "BL_MASK_UNCONSC", BL_MASK_UNCONSC },
    { "BL_MASK_WOUNDEDL", BL_MASK_WOUNDEDL },
    { "BL_MASK_HOLDING", BL_MASK_HOLDING },
    { NULL, 0 }
};

static void
emit_int_table(const char *key, const struct name_int *t)
{
    fputs(",", stdout); json_str(key); fputs(":{", stdout);
    int first = 1;
    for (; t->name; t++) {
        if (!first) fputc(',', stdout);
        json_str(t->name);
        fprintf(stdout, ":%d", t->val);
        first = 0;
    }
    fputc('}', stdout);
}

static void
emit_ulong_table(const char *key, const struct name_ulong *t)
{
    fputs(",", stdout); json_str(key); fputs(":{", stdout);
    int first = 1;
    for (; t->name; t++) {
        if (!first) fputc(',', stdout);
        json_str(t->name);
        fprintf(stdout, ":%lu", t->val);
        first = 0;
    }
    fputc('}', stdout);
}

static void
emit_S_table(void)
{
    fputs(",\"S\":{", stdout);
    int first = 1;
    for (const struct s_row *e = S_TABLE; e->name; e++) {
        if (!first) fputc(',', stdout);
        json_str(e->name);
        fprintf(stdout, ":%d", e->idx);
        first = 0;
    }
    fputc('}', stdout);
}

static void
emit_cmap_table(void)
{
    fputs(",\"cmap\":[", stdout);
    for (int i = 0; i < MAXPCHARS; i++) {
        if (i) fputc(',', stdout);
        char ch[2] = { (char) defsyms[i].sym, '\0' };
        fputs("{\"ch\":", stdout);
        json_str(ch);
        fputs(",\"desc\":", stdout);
        json_str_or_null(defsyms[i].explanation);
        fprintf(stdout, ",\"color\":%d}", (int) defsyms[i].color);
    }
    fputc(']', stdout);
}

static void
emit_extcmds(void)
{
    fputs(",\"extra\":{\"extcmds\":[", stdout);
    int first = 1;
    for (struct ext_func_tab *e = extcmdlist; e->ef_txt; e++) {
        if (!first) fputc(',', stdout);
        fputs("{\"name\":", stdout);
        json_str(e->ef_txt);
        fputs(",\"desc\":", stdout);
        json_str_or_null(e->ef_desc);
        fprintf(stdout, ",\"flags\":%u}", (unsigned) e->flags);
        first = 0;
    }
    fputs("]}", stdout);
}

static void
print_hello(void)
{
    fputs("{\"t\":\"hello\",\"proto\":1,\"version\":", stdout);
    char vbuf[BUFSZ];
    (void) version_string(vbuf, sizeof(vbuf));
    json_str(vbuf);
    emit_S_table();
    emit_cmap_table();
    emit_int_table("nhw", NHW_TABLE);
    emit_int_table("bl", BL_TABLE);
    emit_int_table("pick", PICK_TABLE);
    emit_int_table("atr", ATR_TABLE);
    emit_int_table("mg", MG_TABLE);
    emit_int_table("clr", CLR_TABLE);
    emit_ulong_table("blmask", BLMASK_TABLE);
    emit_extcmds();
    fputs("}\n", stdout);
    fflush(stdout);
}

/* ------------------------------------------------------------------------ */
/* Per-call dispatch. `name` is the raw shim_* name; we emit it without the
 * prefix per the spec (§3.3). */

static void
emit_call_head(const char *name)
{
    fputs("{\"t\":\"call\",\"name\":", stdout);
    /* Strip "shim_" prefix if present. */
    if (strncmp(name, "shim_", 5) == 0)
        json_str(name + 5);
    else
        json_str(name);
    fputs(",\"args\":[", stdout);
}

/* End a call that has no reply. */
static void
emit_call_end_noreply(void)
{
    fputs("]}\n", stdout);
}

/* Begin closing the call line before adding an id. Caller must follow with
 * finish_and_wait() (which prints ",\"id\":N}\n" and flushes). */
static void
emit_args_close(void)
{
    fputc(']', stdout);
}

/* Dispatch a single shim callback. See docs/architecture.md §3.3 for the
 * per-call arg shapes; this is the only place we depend on winshim.c's
 * DECLCB/VDECLCB fmt strings. */
static void
handle_callback(const char *name, void *ret_ptr, const char *fmt, va_list ap)
{
    /* ---- Calls the bridge answers itself (not forwarded, §3.3). -------- */

    if (!strcmp(name, "shim_getmsghistory")) {
        /* fmt="sb", ret is char *. Ignore init arg. */
        (void) va_arg(ap, int);
        if (ret_ptr) *(char **) ret_ptr = NULL;
        return;
    }
    if (!strcmp(name, "shim_get_color_string")) {
        if (ret_ptr) *(char **) ret_ptr = NULL;
        return;
    }
    if (!strcmp(name, "set_shim_font_name")) {
        (void) va_arg(ap, int);            /* winid */
        (void) va_arg(ap, char *);         /* font */
        if (ret_ptr) *(short *) ret_ptr = 0;
        return;
    }
    if (!strcmp(name, "shim_ctrl_nhwindow")) {
        (void) va_arg(ap, int);
        (void) va_arg(ap, int);
        (void) va_arg(ap, void *);
        if (ret_ptr) *(void **) ret_ptr = NULL;
        return;
    }

    /* ---- Simple void calls with no arguments. -------------------------- */

    if (!strcmp(name, "shim_get_nh_event")
     || !strcmp(name, "shim_resume_nhwindows")
     || !strcmp(name, "shim_status_init")
     || !strcmp(name, "shim_nhbell")) {
        emit_call_head(name);
        emit_call_end_noreply();
        return;
    }

    if (!strcmp(name, "shim_mark_synch") || !strcmp(name, "shim_wait_synch")) {
        emit_call_head(name);
        emit_call_end_noreply();
        fflush(stdout);
        return;
    }

    if (!strcmp(name, "shim_delay_output")) {
        emit_call_head(name);
        emit_call_end_noreply();
        fflush(stdout);
        usleep(50000);
        return;
    }

    /* ---- Void calls with a single string argument. --------------------- */

    if (!strcmp(name, "shim_exit_nhwindows")
     || !strcmp(name, "shim_suspend_nhwindows")
     || !strcmp(name, "shim_raw_print")
     || !strcmp(name, "shim_raw_print_bold")
     || !strcmp(name, "shim_update_positionbar")
     || !strcmp(name, "shim_preference_update")) {
        const char *s = va_arg(ap, const char *);
        emit_call_head(name);
        json_str_or_null(s);
        emit_call_end_noreply();
        return;
    }

    /* ---- init_nhwindows: convert argv[] to a JSON array. --------------- */

    if (!strcmp(name, "shim_init_nhwindows")) {
        int *argcp = va_arg(ap, int *);
        char **argv = va_arg(ap, char **);
        emit_call_head(name);
        fputc('[', stdout);
        int n = argcp ? *argcp : 0;
        for (int i = 0; i < n; i++) {
            if (i) fputc(',', stdout);
            json_str_or_null(argv[i]);
        }
        fputc(']', stdout);
        emit_call_end_noreply();
        return;
    }

    /* ---- player_selection_or_tty → boolean. --------------------------- */

    if (!strcmp(name, "shim_player_selection_or_tty")) {
        emit_call_head(name);
        emit_args_close();
        reply_t r;
        finish_and_wait(&r);
        int b = 0;
        if (r.ret_kind == REPLY_RET_BOOL) b = (int) r.ret_int;
        else if (r.ret_kind == REPLY_RET_INT) b = r.ret_int ? 1 : 0;
        if (ret_ptr) *(boolean *) ret_ptr = (boolean) b;
        reply_free(&r);
        return;
    }

    if (!strcmp(name, "shim_player_selection")) {
        emit_call_head(name);
        emit_args_close();
        reply_t r;
        finish_and_wait(&r);
        reply_free(&r);
        return;
    }

    /* ---- askname: void, but blocks for a string; store in svp.plname. -- */

    if (!strcmp(name, "shim_askname")) {
        emit_call_head(name);
        emit_args_close();
        reply_t r;
        finish_and_wait(&r);
        if (r.ret_kind == REPLY_RET_STR && r.ret_str) {
            size_t n = strlen(r.ret_str);
            if (n >= PL_NSIZ) n = PL_NSIZ - 1;
            memcpy(svp.plname, r.ret_str, n);
            svp.plname[n] = '\0';
        }
        reply_free(&r);
        return;
    }

    /* ---- create_nhwindow → winid. ------------------------------------- */

    if (!strcmp(name, "shim_create_nhwindow")) {
        int type = va_arg(ap, int);
        emit_call_head(name);
        fprintf(stdout, "%d", type);
        emit_args_close();
        reply_t r;
        finish_and_wait(&r);
        int wid = 0;
        if (r.ret_kind == REPLY_RET_INT) wid = (int) r.ret_int;
        if (ret_ptr) *(winid *) ret_ptr = (winid) wid;
        menu_reset((winid) wid);
        reply_free(&r);
        return;
    }

    /* ---- Simple int-arg void calls. ----------------------------------- */

    if (!strcmp(name, "shim_clear_nhwindow")
     || !strcmp(name, "shim_destroy_nhwindow")
     || !strcmp(name, "shim_number_pad")
     || !strcmp(name, "shim_update_inventory")
     || !strcmp(name, "shim_change_background")) {
        int a = va_arg(ap, int);
        emit_call_head(name);
        fprintf(stdout, "%d", a);
        emit_call_end_noreply();
        return;
    }

    /* ---- display_nhwindow: blocks only when `blocking` is true. ------- */

    if (!strcmp(name, "shim_display_nhwindow")) {
        int w = va_arg(ap, int);
        int blk = va_arg(ap, int); /* boolean promoted */
        emit_call_head(name);
        fprintf(stdout, "%d,%s", w, blk ? "true" : "false");
        if (!blk) {
            emit_call_end_noreply();
            return;
        }
        emit_args_close();
        reply_t r;
        finish_and_wait(&r);
        reply_free(&r);
        return;
    }

    /* ---- curs [win, x, y]. -------------------------------------------- */

    if (!strcmp(name, "shim_curs")) {
        int w = va_arg(ap, int);
        int x = va_arg(ap, int);
        int y = va_arg(ap, int);
        emit_call_head(name);
        fprintf(stdout, "%d,%d,%d", w, x, y);
        emit_call_end_noreply();
        return;
    }

    /* ---- putstr [win, attr, str]. ------------------------------------- */

    if (!strcmp(name, "shim_putstr")) {
        int w = va_arg(ap, int);
        int attr = va_arg(ap, int);
        const char *s = va_arg(ap, const char *);
        emit_call_head(name);
        fprintf(stdout, "%d,%d,", w, attr);
        json_str_or_null(s);
        emit_call_end_noreply();
        return;
    }

    /* ---- display_file: read via dlb_fopen, block until dismissal. ---- */

    if (!strcmp(name, "shim_display_file")) {
        const char *fname = va_arg(ap, const char *);
        int complain = va_arg(ap, int);
        emit_call_head(name);
        json_str_or_null(fname);
        fprintf(stdout, ",%s,", complain ? "true" : "false");

        /* Slurp file if we can. */
        char *text = NULL;
        size_t tlen = 0, tcap = 0;
        dlb *fp = fname ? dlb_fopen(fname, "r") : NULL;
        if (fp) {
            char buf[512];
            while (dlb_fgets(buf, (int) sizeof(buf), fp)) {
                size_t n = strlen(buf);
                if (tlen + n + 1 > tcap) {
                    while (tlen + n + 1 > tcap) tcap = tcap ? tcap * 2 : 1024;
                    char *nb = (char *) realloc(text, tcap);
                    if (!nb) { free(text); text = NULL; tlen = 0; break; }
                    text = nb;
                }
                if (text) { memcpy(text + tlen, buf, n); tlen += n; text[tlen] = '\0'; }
            }
            dlb_fclose(fp);
        }
        json_str_or_null(text);
        free(text);
        emit_args_close();
        reply_t r;
        finish_and_wait(&r);
        reply_free(&r);
        return;
    }

    /* ---- Menu family. -------------------------------------------------- */

    if (!strcmp(name, "shim_start_menu")) {
        int w = va_arg(ap, int);
        /* mbehavior is declared `unsigned long` in the shim; varargs does
         * not promote unsigned long to int, so read it as unsigned long. */
        unsigned long beh = va_arg(ap, unsigned long);
        emit_call_head(name);
        fprintf(stdout, "%d,%lu", w, beh);
        emit_call_end_noreply();
        menu_reset((winid) w);
        return;
    }

    if (!strcmp(name, "shim_add_menu")) {
        int w = va_arg(ap, int);
        const glyph_info *g = va_arg(ap, const glyph_info *);
        const anything *ident = va_arg(ap, const anything *);
        int ch = va_arg(ap, int);
        int gch = va_arg(ap, int);
        int attr = va_arg(ap, int);
        int clr = va_arg(ap, int);
        const char *str = va_arg(ap, const char *);
        unsigned itemflags = (unsigned) va_arg(ap, int);
        long ii = menu_append((winid) w, ident);
        char chb[2] = { (char) ch, '\0' };
        char gchb[2] = { (char) gch, '\0' };
        emit_call_head(name);
        fprintf(stdout, "%d,", w);
        emit_glyph_info(g);
        fprintf(stdout, ",%ld,", ii);
        json_str(chb);
        fputc(',', stdout);
        json_str(gchb);
        fprintf(stdout, ",%d,%d,", attr, clr);
        json_str_or_null(str);
        fprintf(stdout, ",%u", itemflags);
        emit_call_end_noreply();
        return;
    }

    if (!strcmp(name, "shim_end_menu")) {
        int w = va_arg(ap, int);
        const char *prompt = va_arg(ap, const char *);
        emit_call_head(name);
        fprintf(stdout, "%d,", w);
        json_str_or_null(prompt);
        emit_call_end_noreply();
        return;
    }

    if (!strcmp(name, "shim_select_menu")) {
        int w = va_arg(ap, int);
        int how = va_arg(ap, int);
        MENU_ITEM_P **menu_list = va_arg(ap, MENU_ITEM_P **);
        emit_call_head(name);
        fprintf(stdout, "%d,%d", w, how);
        emit_args_close();
        reply_t r;
        finish_and_wait(&r);
        int ret = 0;
        if (r.ret_kind == REPLY_RET_INT) ret = (int) r.ret_int;
        if (menu_list) *menu_list = NULL;
        /* Guard w before indexing g_menus[]; an out-of-range id means no
         * items (ret stays 0, *menu_list already NULL). */
        if (ret > 0 && w >= 0 && w < MAX_WIN
            && r.sel && r.sel_len > 0 && menu_list) {
            MENU_ITEM_P *arr = (MENU_ITEM_P *) malloc(r.sel_len * sizeof(*arr));
            if (arr) {
                size_t out = 0;
                for (size_t k = 0; k < r.sel_len; k++) {
                    long i = r.sel[k].i;
                    if (i < 0 || (size_t) i >= g_menus[w].len)
                        continue;
                    memset(&arr[out], 0, sizeof(arr[out]));
                    arr[out].item = g_menus[w].items[i];
                    arr[out].count = r.sel[k].count;
                    arr[out].itemflags = 0;
                    out++;
                }
                if (out == 0) { free(arr); ret = 0; }
                else { *menu_list = arr; ret = (int) out; }
            }
        }
        if (ret_ptr) *(int *) ret_ptr = ret;
        reply_free(&r);
        return;
    }

    if (!strcmp(name, "shim_message_menu")) {
        int let = va_arg(ap, int);
        int how = va_arg(ap, int);
        const char *mesg = va_arg(ap, const char *);
        char letb[2] = { (char) let, '\0' };
        emit_call_head(name);
        json_str(letb);
        fprintf(stdout, ",%d,", how);
        json_str_or_null(mesg);
        emit_args_close();
        reply_t r;
        finish_and_wait(&r);
        int c = 0;
        if (r.ret_kind == REPLY_RET_INT) c = (int) r.ret_int;
        else if (r.ret_kind == REPLY_RET_STR && r.ret_str && r.ret_str[0])
            c = (int) (unsigned char) r.ret_str[0];
        if (ret_ptr) *(char *) ret_ptr = (char) c;
        reply_free(&r);
        return;
    }

    /* ---- cliparound. --------------------------------------------------- */

    if (!strcmp(name, "shim_cliparound")) {
        int x = va_arg(ap, int);
        int y = va_arg(ap, int);
        emit_call_head(name);
        fprintf(stdout, "%d,%d", x, y);
        emit_call_end_noreply();
        return;
    }

    /* ---- print_glyph. -------------------------------------------------- */

    if (!strcmp(name, "shim_print_glyph")) {
        int w = va_arg(ap, int);
        int x = va_arg(ap, int);   /* coordxy → int through varargs */
        int y = va_arg(ap, int);
        const glyph_info *g = va_arg(ap, const glyph_info *);
        const glyph_info *bk = va_arg(ap, const glyph_info *);
        emit_call_head(name);
        fprintf(stdout, "%d,%d,%d,", w, x, y);
        emit_glyph_info(g);
        fputc(',', stdout);
        emit_glyph_info(bk);
        emit_call_end_noreply();
        return;
    }

    /* ---- nhgetch → key code. ----------------------------------------- */

    if (!strcmp(name, "shim_nhgetch") || !strcmp(name, "shim_doprev_message")) {
        emit_call_head(name);
        emit_args_close();
        reply_t r;
        finish_and_wait(&r);
        int c = 0;
        if (r.ret_kind == REPLY_RET_INT) c = (int) r.ret_int;
        else if (r.ret_kind == REPLY_RET_STR && r.ret_str && r.ret_str[0])
            c = (int) (unsigned char) r.ret_str[0];
        if (ret_ptr) *(int *) ret_ptr = c;
        reply_free(&r);
        return;
    }

    /* ---- nh_poskey → key code, or 0 + {x,y,mod} for a click. --------- */

    if (!strcmp(name, "shim_nh_poskey")) {
        coordxy *px = va_arg(ap, coordxy *);
        coordxy *py = va_arg(ap, coordxy *);
        int *pmod = va_arg(ap, int *);
        emit_call_head(name);
        emit_args_close();
        reply_t r;
        finish_and_wait(&r);
        int c = 0;
        if (r.ret_kind == REPLY_RET_INT) c = (int) r.ret_int;
        else if (r.ret_kind == REPLY_RET_STR && r.ret_str && r.ret_str[0])
            c = (int) (unsigned char) r.ret_str[0];
        if (c == 0) {
            if (px) *px = (coordxy) (r.has_x ? r.x : 0);
            if (py) *py = (coordxy) (r.has_y ? r.y : 0);
            if (pmod) *pmod = (int) (r.has_mod ? r.mod : 0);
        }
        if (ret_ptr) *(int *) ret_ptr = c;
        reply_free(&r);
        return;
    }

    /* ---- yn_function → char. ----------------------------------------- */

    if (!strcmp(name, "shim_yn_function")) {
        const char *query = va_arg(ap, const char *);
        const char *resp = va_arg(ap, const char *);
        int def = va_arg(ap, int);
        char defb[2] = { (char) def, '\0' };
        emit_call_head(name);
        json_str_or_null(query);
        fputc(',', stdout);
        json_str_or_null(resp);
        fputc(',', stdout);
        json_str(defb);
        emit_args_close();
        reply_t r;
        finish_and_wait(&r);
        int c = def;
        if (r.ret_kind == REPLY_RET_INT) c = (int) r.ret_int;
        else if (r.ret_kind == REPLY_RET_STR && r.ret_str && r.ret_str[0])
            c = (int) (unsigned char) r.ret_str[0];
        if (ret_ptr) *(char *) ret_ptr = (char) c;
        reply_free(&r);
        return;
    }

    /* ---- getlin → string; copy into caller's bufp (BUFSZ - 1 max). --- */

    if (!strcmp(name, "shim_getlin")) {
        const char *query = va_arg(ap, const char *);
        char *bufp = va_arg(ap, char *);
        emit_call_head(name);
        json_str_or_null(query);
        emit_args_close();
        reply_t r;
        finish_and_wait(&r);
        if (bufp) {
            const char *src = "";
            if (r.ret_kind == REPLY_RET_STR && r.ret_str) src = r.ret_str;
            size_t n = strlen(src);
            if (n >= BUFSZ) n = BUFSZ - 1;
            memcpy(bufp, src, n);
            bufp[n] = '\0';
        }
        reply_free(&r);
        return;
    }

    /* ---- get_ext_cmd → int index into extcmdlist. -------------------- */

    if (!strcmp(name, "shim_get_ext_cmd")) {
        emit_call_head(name);
        emit_args_close();
        reply_t r;
        finish_and_wait(&r);
        int idx = -1;
        if (r.ret_kind == REPLY_RET_INT) idx = (int) r.ret_int;
        if (ret_ptr) *(int *) ret_ptr = idx;
        reply_free(&r);
        return;
    }

    /* ---- change_color [color, rgb, reverse]. ------------------------- */

    if (!strcmp(name, "shim_change_color")) {
        int color = va_arg(ap, int);
        long rgb = va_arg(ap, long);
        int rev = va_arg(ap, int);
        emit_call_head(name);
        fprintf(stdout, "%d,%ld,%d", color, rgb, rev);
        emit_call_end_noreply();
        return;
    }

    /* ---- putmsghistory [msg, restoring]. ----------------------------- */

    if (!strcmp(name, "shim_putmsghistory")) {
        const char *msg = va_arg(ap, const char *);
        int restoring = va_arg(ap, int);
        emit_call_head(name);
        json_str_or_null(msg);
        fprintf(stdout, ",%s", restoring ? "true" : "false");
        emit_call_end_noreply();
        return;
    }

    /* ---- status_enablefield [idx, name, fmt, enable]. --------------- */

    if (!strcmp(name, "shim_status_enablefield")) {
        int idx = va_arg(ap, int);
        const char *nm = va_arg(ap, const char *);
        const char *sfmt = va_arg(ap, const char *);
        int en = va_arg(ap, int);
        emit_call_head(name);
        fprintf(stdout, "%d,", idx);
        json_str_or_null(nm);
        fputc(',', stdout);
        json_str_or_null(sfmt);
        fprintf(stdout, ",%s", en ? "true" : "false");
        emit_call_end_noreply();
        return;
    }

    /* ---- status_update: ptr type depends on fldidx. ------------------ */

    if (!strcmp(name, "shim_status_update")) {
        int fld = va_arg(ap, int);
        void *ptr = va_arg(ap, void *);
        int chg = va_arg(ap, int);
        int pct = va_arg(ap, int);
        int col = va_arg(ap, int);
        (void) va_arg(ap, void *); /* colormasks — not exposed */
        emit_call_head(name);
        fprintf(stdout, "%d,", fld);
        if (fld == BL_FLUSH || fld == BL_RESET || !ptr) {
            fputs("null", stdout);
        } else if (fld == BL_CONDITION) {
            unsigned long v = *(unsigned long *) ptr;
            fprintf(stdout, "%lu", v);
        } else {
            json_str_or_null((const char *) ptr);
        }
        fprintf(stdout, ",%d,%d,%d", chg, pct, col);
        emit_call_end_noreply();
        return;
    }

    /* ---- Fallback: unknown call. Log and, if a return is expected,
     * zero the return slot so NetHack doesn't wedge. --------------- */

    print_log(name);
    if (ret_ptr && fmt && *fmt) {
        /* Zero exactly the width the return type names: a 1-byte char /
         * boolean / yn-char (c/b/0), a 2-byte short (2), an int (i), a
         * pointer (s/p). Never memset a whole word — the slot may be a
         * 1- or 2-byte scalar. 'v' has no return slot at all. */
        switch (*fmt) {
        case 'v': /* no return slot */ break;
        case 'c': case 'b': case '0': *(char *) ret_ptr = 0; break;
        case '2': *(short *) ret_ptr = 0; break;
        case 'i': *(int *) ret_ptr = 0; break;
        case 's': case 'p': *(void **) ret_ptr = NULL; break;
        default: memset(ret_ptr, 0, sizeof(void *)); break;
        }
    }
}

static void
bridge_callback(const char *name, void *ret_ptr, const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    handle_callback(name, ret_ptr, fmt, ap);
    va_end(ap);
}

/* ------------------------------------------------------------------------ */
/* Entry point. */

static void
atexit_emit(void)
{
    /* If NetHack (or a library) called exit() we still owe an exit line. */
    print_exit(0, "atexit");
}

int
main(int argc, char *argv[])
{
    /* 256 KiB stdout buffer per §3.2 (bursty print_glyph traffic). */
    static char stdout_buf[1 << 18];
    setvbuf(stdout, stdout_buf, _IOFBF, sizeof(stdout_buf));

    /* NetHack's libnh build is compiled without CHDIR (the linux.500 hints),
     * so nhmain() never enters the playground itself. fqn_prefix[] defaults
     * to NULL, which makes lock/save/record file lookups happen relative to
     * the current working directory. Do the chdir ourselves so setups with
     * a bespoke NETHACKDIR/HACKDIR actually reach the data files. */
    const char *dir = getenv("NETHACKDIR");
    if (!dir) dir = getenv("HACKDIR");
    if (dir && *dir && chdir(dir) != 0) {
        char buf[256];
        snprintf(buf, sizeof(buf), "chdir(NETHACKDIR=%s) failed: %s",
                 dir, strerror(errno));
        die_reason(buf);
    }

    print_hello();

    if (atexit(atexit_emit) != 0) {
        /* Non-fatal; we just may lose the exit line on abnormal exit. */
    }
    shim_graphics_set_callback(bridge_callback);

    int code = nhmain(argc, argv);
    print_exit(code, NULL);
    fflush(stdout);
    return code;
}
