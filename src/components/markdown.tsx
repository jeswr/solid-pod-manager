"use client";

/**
 * Renders the {@link parseMarkdown} AST as React elements. There is no HTML
 * string and no `dangerouslySetInnerHTML`: every node maps to a known element
 * and all text is React-escaped, so pod/note content cannot inject markup.
 * Links are gated through `safeLinkHref` (http/https/mailto only) and rendered
 * inert when unsafe.
 */
import { Fragment, type ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "@/lib/markdown";
import { safeLinkHref } from "@/lib/pod-scope";

function renderInline(nodes: Inline[]): ReactNode {
  return nodes.map((node, i) => {
    switch (node.type) {
      case "text":
        return <Fragment key={i}>{node.value}</Fragment>;
      case "strong":
        return <strong key={i}>{renderInline(node.children)}</strong>;
      case "em":
        return <em key={i}>{renderInline(node.children)}</em>;
      case "code":
        return (
          <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">
            {node.value}
          </code>
        );
      case "link": {
        const href = safeLinkHref(node.href);
        if (!href) {
          // Unsafe scheme (javascript:, data:, …) — render the text inert.
          return <Fragment key={i}>{renderInline(node.children)}</Fragment>;
        }
        return (
          <a
            key={i}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-primary underline underline-offset-4"
          >
            {renderInline(node.children)}
          </a>
        );
      }
    }
  });
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.type) {
    case "heading": {
      const cls =
        block.level <= 2
          ? "mt-4 text-lg font-semibold first:mt-0"
          : "mt-3 text-base font-semibold first:mt-0";
      const inner = renderInline(block.children);
      switch (block.level) {
        case 1:
          return <h1 key={key} className={cls}>{inner}</h1>;
        case 2:
          return <h2 key={key} className={cls}>{inner}</h2>;
        case 3:
          return <h3 key={key} className={cls}>{inner}</h3>;
        case 4:
          return <h4 key={key} className={cls}>{inner}</h4>;
        case 5:
          return <h5 key={key} className={cls}>{inner}</h5>;
        default:
          return <h6 key={key} className={cls}>{inner}</h6>;
      }
    }
    case "paragraph":
      return (
        <p key={key} className="leading-relaxed text-pretty">
          {renderInline(block.children)}
        </p>
      );
    case "code":
      return (
        <pre
          key={key}
          className="overflow-x-auto rounded-xl bg-muted p-3 font-mono text-sm"
        >
          <code>{block.value}</code>
        </pre>
      );
    case "blockquote":
      return (
        <blockquote
          key={key}
          className="border-l-2 border-border pl-4 text-muted-foreground"
        >
          {renderInline(block.children)}
        </blockquote>
      );
    case "list": {
      const items = block.items.map((item, i) => <li key={i}>{renderInline(item)}</li>);
      return block.ordered ? (
        <ol key={key} className="list-decimal pl-6">{items}</ol>
      ) : (
        <ul key={key} className="list-disc pl-6">{items}</ul>
      );
    }
    case "hr":
      return <hr key={key} className="border-border" />;
  }
}

/** Render Markdown source as safe React elements. */
export function Markdown({ source }: { source: string }) {
  const blocks = parseMarkdown(source);
  if (blocks.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing to preview yet.</p>;
  }
  return <div className="flex flex-col gap-2">{blocks.map((b, i) => renderBlock(b, i))}</div>;
}
