"use client";

import type { JSX } from "react";
import type { Components, ExtraProps } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cx } from "./icon";

type MdProps<T extends keyof JSX.IntrinsicElements> = JSX.IntrinsicElements[T] & ExtraProps;

function stripNode<T extends ExtraProps>(props: T) {
  const rest = { ...props };
  delete rest.node;
  return rest;
}

const components: Components = {
  h1: ({ children, className, ...props }: MdProps<"h1">) => (
    <h1
      {...stripNode(props)}
      className={cx("mt-3 mb-1.5 text-[15px] font-bold tracking-tight text-slate-900 first:mt-0", className)}
    >
      {children}
    </h1>
  ),
  h2: ({ children, className, ...props }: MdProps<"h2">) => (
    <h2
      {...stripNode(props)}
      className={cx("mt-3 mb-1.5 text-[14px] font-bold tracking-tight text-slate-900 first:mt-0", className)}
    >
      {children}
    </h2>
  ),
  h3: ({ children, className, ...props }: MdProps<"h3">) => (
    <h3
      {...stripNode(props)}
      className={cx("mt-2.5 mb-1 text-[13.5px] font-bold text-slate-800 first:mt-0", className)}
    >
      {children}
    </h3>
  ),
  p: ({ children, className, ...props }: MdProps<"p">) => (
    <p {...stripNode(props)} className={cx("my-1.5 first:mt-0 last:mb-0", className)}>
      {children}
    </p>
  ),
  strong: ({ children, className, ...props }: MdProps<"strong">) => (
    <strong {...stripNode(props)} className={cx("font-semibold text-slate-800", className)}>
      {children}
    </strong>
  ),
  em: ({ children, className, ...props }: MdProps<"em">) => (
    <em {...stripNode(props)} className={cx("italic", className)}>
      {children}
    </em>
  ),
  ul: ({ children, className, ...props }: MdProps<"ul">) => (
    <ul
      {...stripNode(props)}
      className={cx("my-1.5 list-disc space-y-1 pl-4 first:mt-0 last:mb-0", className)}
    >
      {children}
    </ul>
  ),
  ol: ({ children, className, ...props }: MdProps<"ol">) => (
    <ol
      {...stripNode(props)}
      className={cx("my-1.5 list-decimal space-y-1 pl-4 first:mt-0 last:mb-0", className)}
    >
      {children}
    </ol>
  ),
  li: ({ children, className, ...props }: MdProps<"li">) => (
    <li {...stripNode(props)} className={cx("pl-0.5 [&>p]:my-0.5", className)}>
      {children}
    </li>
  ),
  a: ({ children, href, className, ...props }: MdProps<"a">) => (
    <a
      {...stripNode(props)}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cx(
        "font-medium text-[var(--accent)] underline underline-offset-2 hover:text-[var(--accent-strong)]",
        className,
      )}
    >
      {children}
    </a>
  ),
  code: ({ children, className, ...props }: MdProps<"code">) => (
    <code
      {...stripNode(props)}
      className={cx(
        "rounded bg-slate-100 px-1 py-px font-mono text-[12px] text-slate-800",
        className,
      )}
    >
      {children}
    </code>
  ),
  pre: ({ children, className, ...props }: MdProps<"pre">) => (
    <pre
      {...stripNode(props)}
      className={cx(
        "my-2 overflow-x-auto rounded-lg bg-slate-900 px-3 py-2 font-mono text-[12px] leading-relaxed text-slate-100 [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit",
        className,
      )}
    >
      {children}
    </pre>
  ),
  blockquote: ({ children, className, ...props }: MdProps<"blockquote">) => (
    <blockquote
      {...stripNode(props)}
      className={cx("my-1.5 border-l-2 border-slate-300 pl-3 text-slate-500 first:mt-0 last:mb-0", className)}
    >
      {children}
    </blockquote>
  ),
  hr: ({ className, ...props }: MdProps<"hr">) => (
    <hr {...stripNode(props)} className={cx("my-2.5 border-slate-200", className)} />
  ),
  table: ({ children, className, ...props }: MdProps<"table">) => (
    <div className="my-2 overflow-x-auto first:mt-0 last:mb-0">
      <table
        {...stripNode(props)}
        className={cx("w-full min-w-[16rem] border-collapse text-left text-[12.5px]", className)}
      >
        {children}
      </table>
    </div>
  ),
  thead: ({ children, className, ...props }: MdProps<"thead">) => (
    <thead {...stripNode(props)} className={cx("bg-slate-50", className)}>
      {children}
    </thead>
  ),
  tbody: ({ children, className, ...props }: MdProps<"tbody">) => (
    <tbody {...stripNode(props)} className={className}>
      {children}
    </tbody>
  ),
  tr: ({ children, className, ...props }: MdProps<"tr">) => (
    <tr {...stripNode(props)} className={cx("border-b border-slate-100 last:border-0", className)}>
      {children}
    </tr>
  ),
  th: ({ children, className, ...props }: MdProps<"th">) => (
    <th
      {...stripNode(props)}
      className={cx("px-2 py-1.5 font-semibold whitespace-nowrap text-slate-700", className)}
    >
      {children}
    </th>
  ),
  td: ({ children, className, ...props }: MdProps<"td">) => (
    <td {...stripNode(props)} className={cx("px-2 py-1.5 align-top text-slate-600", className)}>
      {children}
    </td>
  ),
  del: ({ children, className, ...props }: MdProps<"del">) => (
    <del {...stripNode(props)} className={cx("text-slate-400", className)}>
      {children}
    </del>
  ),
};

/** Renders GFM markdown (headings, lists, tables, emphasis) for AI responses. */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cx("min-w-0 break-words [overflow-wrap:anywhere]", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
