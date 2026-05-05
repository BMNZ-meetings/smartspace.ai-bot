// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Recreate the MARKDOWN_COMPONENTS link sanitisation logic for isolated testing.
// This mirrors the exact pattern from ChatWidget.jsx module-level constants.
const MARKDOWN_COMPONENTS = {
  a: ({ href, children }) => {
    const safeHref = href && /^https?:\/\//i.test(href) ? href : undefined;
    return safeHref ? (
      <a href={safeHref} target="_blank" rel="noopener noreferrer">{children}</a>
    ) : (
      <span>{children}</span>
    );
  },
};

// Recreate preprocessMarkdown and isDiagramLine for direct unit testing.
// These mirror the exact implementations in ChatWidget.jsx.
function isDiagramLine(line) {
  if (/[┌┐└┘│─├┤┬┴┼╔╗╚╝║═]/.test(line)) return true;
  if (/^\s*[↓↑→←]\s*$/.test(line)) return true;
  if (/^\s*[|]\s*$/.test(line)) return true;
  if (/^\s*v\s*$/.test(line)) return true;
  if (/[+][-]{3,}|[-]{3,}[+]/.test(line)) return true;
  if (/[=]{4,}/.test(line)) return true;
  return false;
}

function preprocessMarkdown(text) {
  const lines = text.split("\n");
  const result = [];
  let inCodeBlock = false;
  let buffer = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (isDiagramLine(line)) {
      if (!inCodeBlock) {
        result.push("```");
        inCodeBlock = true;
      }
      result.push(...buffer);
      buffer = [];
      result.push(line);
    } else if (inCodeBlock) {
      buffer.push(line);
      let moreDiagram = false;
      for (let j = i + 1; j <= Math.min(lines.length - 1, i + 5); j++) {
        if (isDiagramLine(lines[j])) {
          moreDiagram = true;
          break;
        }
      }
      if (!moreDiagram) {
        result.push("```");
        result.push(...buffer);
        buffer = [];
        inCodeBlock = false;
      }
    } else {
      result.push(line);
    }
  }

  if (inCodeBlock) {
    result.push("```");
    result.push(...buffer);
  }

  return result.join("\n");
}

describe("isDiagramLine", () => {
  it("recognises Unicode box-drawing characters", () => {
    expect(isDiagramLine("┌──────────┐")).toBe(true);
    expect(isDiagramLine("│  Hello   │")).toBe(true);
    expect(isDiagramLine("└──────────┘")).toBe(true);
    expect(isDiagramLine("╔══════════╗")).toBe(true);
  });

  it("recognises ASCII box borders", () => {
    expect(isDiagramLine("+--------+")).toBe(true);
    expect(isDiagramLine("---+---")).toBe(true);
  });

  it("recognises standalone pipe and arrow lines", () => {
    expect(isDiagramLine("  |  ")).toBe(true);
    expect(isDiagramLine("  v  ")).toBe(true);
    expect(isDiagramLine("  ↓  ")).toBe(true);
    expect(isDiagramLine("  →  ")).toBe(true);
  });

  it("recognises separator lines", () => {
    expect(isDiagramLine("========")).toBe(true);
  });

  it("rejects normal text", () => {
    expect(isDiagramLine("Hello world")).toBe(false);
    expect(isDiagramLine("This is **bold**")).toBe(false);
    expect(isDiagramLine("A regular sentence.")).toBe(false);
  });
});

describe("preprocessMarkdown", () => {
  it("wraps Unicode box-drawing lines in code blocks", () => {
    const input = "Here is a diagram:\n┌──────────┐\n│  Hello   │\n└──────────┘";
    const output = preprocessMarkdown(input);
    expect(output).toContain("```");
    expect(output).toContain("┌──────────┐");
    // The diagram lines should be between ``` markers
    const lines = output.split("\n");
    const firstFence = lines.indexOf("```");
    const secondFence = lines.indexOf("```", firstFence + 1);
    expect(firstFence).toBeGreaterThan(-1);
    expect(secondFence).toBeGreaterThan(firstFence);
  });

  it("leaves normal markdown untouched", () => {
    const input = "This is **bold** and a [link](https://example.com)";
    const output = preprocessMarkdown(input);
    expect(output).toBe(input);
  });

  it("bridges gaps of up to 5 non-diagram lines between diagram sections", () => {
    const input = "┌───┐\nsome text\nmore text\n└───┘";
    const output = preprocessMarkdown(input);
    // Both diagram lines should be in the same code block
    const fences = output.split("\n").filter(l => l === "```");
    expect(fences.length).toBe(2); // one opening, one closing
  });

  it("closes unclosed code block at end of input", () => {
    const input = "┌───┐\n│ x │";
    const output = preprocessMarkdown(input);
    const fences = output.split("\n").filter(l => l === "```");
    expect(fences.length).toBe(2);
  });
});

describe("MARKDOWN_COMPONENTS link sanitisation (XSS)", () => {
  it("renders javascript: href as span, not link", () => {
    const { container } = render(
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {"[click me](javascript:alert('xss'))"}
      </ReactMarkdown>,
    );
    expect(container.querySelectorAll("a")).toHaveLength(0);
    const spans = container.querySelectorAll("span");
    const xssSpan = Array.from(spans).find((s) => s.textContent === "click me");
    expect(xssSpan).toBeTruthy();
  });

  it("renders data: href as span, not link", () => {
    const { container } = render(
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {"[payload](data:text/html,<script>alert(1)</script>)"}
      </ReactMarkdown>,
    );
    expect(container.querySelectorAll("a")).toHaveLength(0);
  });

  it("renders https href as clickable link with target=_blank", () => {
    const { container } = render(
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {"[safe link](https://example.com)"}
      </ReactMarkdown>,
    );
    const link = container.querySelector("a");
    expect(link).toBeTruthy();
    expect(link.getAttribute("href")).toBe("https://example.com");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("renders http href as clickable link with target=_blank", () => {
    const { container } = render(
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {"[http link](http://example.com)"}
      </ReactMarkdown>,
    );
    const link = container.querySelector("a");
    expect(link).toBeTruthy();
    expect(link.getAttribute("href")).toBe("http://example.com");
    expect(link.getAttribute("target")).toBe("_blank");
  });
});
