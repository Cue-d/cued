/**
 * URL detection and link rendering utilities
 */

import React from 'react'

// Regex to detect URLs (http, https, and common patterns)
const URL_REGEX = /(https?:\/\/[^\s]+|www\.[^\s]+|[a-zA-Z0-9-]+\.[a-zA-Z]{2,}[^\s]*)/gi

/**
 * Check if a string is a URL
 */
export function isUrl(text: string): boolean {
  return URL_REGEX.test(text.trim())
}

/**
 * Extract all URLs from text
 */
export function extractUrls(text: string): Array<{ url: string; index: number; length: number }> {
  const urls: Array<{ url: string; index: number; length: number }> = []
  const matches = Array.from(text.matchAll(URL_REGEX))

  for (const match of matches) {
    if (match.index !== undefined) {
      let url = match[0]
      const originalLength = url.length
      // Add http:// if it's a www. or domain without protocol
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url
      }
      urls.push({ url, index: match.index, length: originalLength })
    }
  }

  return urls
}

/**
 * Render text with clickable links
 */
export function renderTextWithLinks(text: string, className?: string): React.ReactNode {
  const urls = extractUrls(text)

  if (urls.length === 0) {
    return <span className={className}>{text}</span>
  }

  const parts: React.ReactNode[] = []
  let lastIndex = 0

  urls.forEach(({ url, index, length }) => {
    // Add text before the URL
    if (index > lastIndex) {
      parts.push(
        <span key={`text-${lastIndex}`} className={className}>
          {text.substring(lastIndex, index)}
        </span>
      )
    }

    // Add the link
    const linkText = text.substring(index, index + length)
    parts.push(
      <a
        key={`link-${index}`}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-600 dark:text-blue-400 underline break-all font-medium hover:text-blue-800 dark:hover:text-blue-300"
        onClick={(e) => e.stopPropagation()}
      >
        {linkText}
      </a>
    )

    lastIndex = index + length
  })

  // Add remaining text after last URL
  if (lastIndex < text.length) {
    parts.push(
      <span key={`text-${lastIndex}`} className={className}>
        {text.substring(lastIndex)}
      </span>
    )
  }

  return <>{parts}</>
}
