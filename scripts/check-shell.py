#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""POSIX shell 静态语法检查：引号配对、$() 嵌套、控制关键字配平。"""
import sys


def skip_subst(s, i, errs):
    """s[i] == '(' 对应 $() 的括号，返回配对的 ')' 之后的位置。"""
    depth = 0
    n = len(s)
    while i < n:
        c = s[i]
        if c == '\\':
            i += 2
            continue
        if c == "'":
            j = s.find("'", i + 1)
            if j < 0:
                errs.append(('未闭合的单引号', i))
                return n
            i = j + 1
            continue
        if c == '"':
            j = i + 1
            while j < n:
                if s[j] == '\\':
                    j += 2
                    continue
                if s[j] == '"':
                    break
                if s[j] == '$' and j + 1 < n and s[j + 1] == '(':
                    j = skip_subst(s, j + 1, errs)
                    continue
                j += 1
            if j >= n:
                errs.append(('未闭合的双引号', i))
                return n
            i = j + 1
            continue
        if c == '`':
            j = s.find('`', i + 1)
            if j < 0:
                errs.append(('未闭合的反引号', i))
                return n
            i = j + 1
            continue
        if c == '$' and i + 1 < n and s[i + 1] == '(':
            i = skip_subst(s, i + 1, errs)
            continue
        if c == '(':
            depth += 1
        elif c == ')':
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    errs.append(('$() 未闭合', i))
    return n


def tokenize(src, errs):
    toks = []
    i = 0
    n = len(src)
    while i < n:
        c = src[i]
        if c in ' \t\r\n':
            i += 1
            continue
        if c == '\\':
            i += 2
            continue
        if c == '#':
            while i < n and src[i] != '\n':
                i += 1
            continue
        if c == '"':
            j = i + 1
            while j < n:
                if src[j] == '\\':
                    j += 2
                    continue
                if src[j] == '"':
                    break
                if src[j] == '$' and j + 1 < n and src[j + 1] == '(':
                    j = skip_subst(src, j + 1, errs)
                    continue
                j += 1
            if j >= n:
                errs.append(('未闭合的双引号', i))
                return toks
            i = j + 1
            toks.append(('""', i))
            continue
        if c == "'":
            j = src.find("'", i + 1)
            if j < 0:
                errs.append(('未闭合的单引号', i))
                return toks
            i = j + 1
            toks.append(("''", i))
            continue
        if c == '`':
            j = src.find('`', i + 1)
            if j < 0:
                errs.append(('未闭合的反引号', i))
                return toks
            i = j + 1
            toks.append(('``', i))
            continue
        if c == '$' and i + 1 < n and src[i + 1] == '(':
            i = skip_subst(src, i + 1, errs)
            toks.append(('$()', i))
            continue
        if c in ';&|()':
            toks.append((c, i))
            i += 1
            continue
        start = i
        buf = []
        while i < n and src[i] not in ' \t\r\n;&|()':
            ch = src[i]
            if ch == '\\':
                i += 2
                continue
            if ch == "'":
                j = src.find("'", i + 1)
                if j < 0:
                    errs.append(('未闭合的单引号', i))
                    return toks
                i = j + 1
                buf.append('x')
                continue
            if ch == '"':
                j = i + 1
                while j < n:
                    if src[j] == '\\':
                        j += 2
                        continue
                    if src[j] == '"':
                        break
                    if src[j] == '$' and j + 1 < n and src[j + 1] == '(':
                        j = skip_subst(src, j + 1, errs)
                        continue
                    j += 1
                if j >= n:
                    errs.append(('未闭合的双引号', i))
                    return toks
                i = j + 1
                buf.append('x')
                continue
            if ch == '$' and i + 1 < n and src[i + 1] == '(':
                i = skip_subst(src, i + 1, errs)
                buf.append('x')
                continue
            if ch == '`':
                j = src.find('`', i + 1)
                if j < 0:
                    errs.append(('未闭合的反引号', i))
                    return toks
                i = j + 1
                buf.append('x')
                continue
            buf.append(ch)
            i += 1
        toks.append((''.join(buf), start))
    return toks


OPEN_CLOSE = {'if': 'fi', 'case': 'esac', 'do': 'done'}
CLOSERS = {'fi', 'esac', 'done'}


def check(path):
    src = open(path, encoding='utf-8').read()
    errs = []
    toks = tokenize(src, errs)
    stack = []
    for word, pos in toks:
        line = src.count('\n', 0, pos) + 1
        if word in OPEN_CLOSE:
            stack.append((word, line))
        elif word in CLOSERS:
            if not stack:
                errs.append(('第 %d 行：多余的 %s' % (line, word), pos))
                continue
            op, oline = stack.pop()
            if OPEN_CLOSE[op] != word:
                errs.append(('第 %d 行：%s（第 %d 行）被 %s 关闭' % (line, op, oline, word), pos))
    for op, line in stack:
        errs.append(('第 %d 行：%s 没有对应的 %s' % (line, op, OPEN_CLOSE[op]), 0))

    # 'then' 必须在 if 之后出现（粗检）
    print('=' * 60)
    print('文件：%s' % path)
    if errs:
        for msg, _ in errs:
            print('  错误：%s' % msg)
        return 1
    print('  通过：引号配对、$() 嵌套、if/fi、case/esac、do/done 均配平')
    return 0


if __name__ == '__main__':
    rc = 0
    for p in sys.argv[1:]:
        rc |= check(p)
    sys.exit(rc)
