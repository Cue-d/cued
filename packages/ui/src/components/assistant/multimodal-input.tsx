"use client";

import { AnimatePresence, motion, type Transition } from "motion/react";
import {
  type ChangeEvent,
  type Dispatch,
  memo,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowUpIcon, PaperclipIcon, StopIcon } from "./icons";
import { type Attachment, PreviewAttachment } from "./preview-attachment";
import {
  PromptInput,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputToolbar,
  PromptInputTools,
} from "./prompt-input";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";

// Re-export Attachment type for consumers
export type { Attachment };

// ============================================================================
// MORPH SURFACE CONSTANTS
// ============================================================================
// Fixed heights for each content layer (following morph surface pattern)
const SURFACE_HEIGHTS = {
  base: 120, // Input + toolbar only (tight fit)
  inputLayer: 108, // Must match base - input fills entire base state
  attachments: 76, // Attachments preview height
} as const;

// Spring configuration for smooth morphing
const MORPH_SPRING: Transition = {
  type: "spring",
  stiffness: 475,
  damping: 37.5,
};

// Crossfade configuration for inner content
const CROSSFADE_TRANSITION: Transition = {
  duration: 0.1,
  ease: [0.2, 0, 0.2, 1],
};

interface MultimodalInputProps {
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  onSubmit: () => void;
  attachments: Attachment[];
  setAttachments: Dispatch<SetStateAction<Attachment[]>>;
  isSubmitting?: boolean;
  onStop?: () => void;
  className?: string;
  placeholder?: string;
}

function PureMultimodalInput({
  input,
  setInput,
  onSubmit,
  attachments,
  setAttachments,
  isSubmitting = false,
  onStop,
  className,
  placeholder = "Ask about your conversations...",
}: MultimodalInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadQueue, setUploadQueue] = useState<string[]>([]);

  // ============================================================================
  // MORPH SURFACE STATE CALCULATIONS
  // ============================================================================
  const hasAttachments = attachments.length > 0;
  const hasUploadQueue = uploadQueue.length > 0;

  // Calculate the target height based on current state
  const surfaceHeight = useMemo(() => {
    let height = SURFACE_HEIGHTS.base;

    if (hasAttachments || hasUploadQueue) {
      height += SURFACE_HEIGHTS.attachments;
    }

    return height;
  }, [hasAttachments, hasUploadQueue]);

  // Calculate border radius based on state
  const surfaceBorderRadius = useMemo(() => {
    // More rounded when compact, less when expanded
    return hasAttachments || hasUploadQueue ? 16 : 20;
  }, [hasAttachments, hasUploadQueue]);

  const adjustHeight = useCallback(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "36px";
    }
  }, []);

  useEffect(() => {
    if (textareaRef.current) {
      adjustHeight();
    }
  }, [adjustHeight]);

  // Auto-focus on mount
  const hasAutoFocused = useRef(false);
  useEffect(() => {
    if (hasAutoFocused.current) {
      return;
    }
    const timer = setTimeout(() => {
      textareaRef.current?.focus();
      hasAutoFocused.current = true;
    }, 100);
    return () => clearTimeout(timer);
  }, []);

  const resetHeight = useCallback(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "36px";
    }
  }, []);

  const handleInput = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(event.target.value);
  };

  const submitForm = useCallback(() => {
    // Don't submit empty messages (no text and no attachments)
    if (!input.trim() && attachments.length === 0) {
      return;
    }

    onSubmit();
    resetHeight();
  }, [input, attachments, onSubmit, resetHeight]);

  // Convert file to base64 data URL for local preview (no server upload)
  const fileToDataUrl = useCallback((file: File): Promise<Attachment> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        resolve({
          url: reader.result as string,
          name: file.name,
          contentType: file.type,
        });
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }, []);

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files || []);

      setUploadQueue(files.map((file) => file.name));

      try {
        const attachmentPromises = files.map((file) => fileToDataUrl(file));
        const newAttachments = await Promise.all(attachmentPromises);

        setAttachments((currentAttachments) => [
          ...currentAttachments,
          ...newAttachments,
        ]);
      } catch (error) {
        console.error("Error processing files:", error);
      } finally {
        setUploadQueue([]);
        // Reset file input
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
      }
    },
    [setAttachments, fileToDataUrl]
  );

  const handlePaste = useCallback(
    async (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) {
        return;
      }

      const imageItems = Array.from(items).filter((item) =>
        item.type.startsWith("image/")
      );

      if (imageItems.length === 0) {
        return;
      }

      // Prevent default paste behavior for images
      event.preventDefault();

      setUploadQueue((prev) => [...prev, "Pasted image"]);

      try {
        const files = imageItems
          .map((item) => item.getAsFile())
          .filter((file): file is File => file !== null);

        const attachmentPromises = files.map((file) => fileToDataUrl(file));
        const newAttachments = await Promise.all(attachmentPromises);

        setAttachments((curr) => [...curr, ...newAttachments]);
      } catch (error) {
        console.error("Error processing pasted images:", error);
      } finally {
        setUploadQueue([]);
      }
    },
    [setAttachments, fileToDataUrl]
  );

  // Add paste event listener to textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.addEventListener("paste", handlePaste);
    return () => textarea.removeEventListener("paste", handlePaste);
  }, [handlePaste]);

  return (
    <div className={cn("relative flex w-full flex-col gap-4", className)}>
      <input
        className="pointer-events-none fixed -top-4 -left-4 size-0.5 opacity-0"
        multiple
        onChange={handleFileChange}
        ref={fileInputRef}
        tabIndex={-1}
        type="file"
        accept="image/*"
      />

      {/* ================================================================== */}
      {/* MORPH SURFACE CONTAINER                                           */}
      {/* Only this outer container animates dimensions                      */}
      {/* Inner content is absolute positioned and crossfades                */}
      {/* ================================================================== */}
      <motion.div
        animate={{
          height: surfaceHeight,
          borderRadius: surfaceBorderRadius,
          opacity: 1,
          y: 0,
          scale: 1,
        }}
        className="relative overflow-hidden border border-border/40 bg-card/60 shadow-lg shadow-black/5 backdrop-blur-md ring-1 ring-white/5"
        initial={false}
        transition={MORPH_SPRING}
      >
        {/* ============================================================== */}
        {/* ATTACHMENTS - Positioned above input layer                     */}
        {/* ============================================================== */}
        <AnimatePresence mode="wait">
          {(hasAttachments || hasUploadQueue) && (
            <motion.div
              animate={{ opacity: 1 }}
              className="absolute inset-x-0 flex flex-row items-end gap-2 overflow-x-auto px-3"
              data-testid="attachments-preview"
              exit={{ opacity: 0 }}
              initial={{ opacity: 0 }}
              key="attachments"
              style={{
                bottom: SURFACE_HEIGHTS.inputLayer,
                height: SURFACE_HEIGHTS.attachments,
              }}
              transition={CROSSFADE_TRANSITION}
            >
              {attachments.map((attachment) => (
                <PreviewAttachment
                  attachment={attachment}
                  key={attachment.url}
                  onRemove={() => {
                    setAttachments((currentAttachments) =>
                      currentAttachments.filter((a) => a.url !== attachment.url)
                    );
                    if (fileInputRef.current) {
                      fileInputRef.current.value = "";
                    }
                  }}
                />
              ))}

              {uploadQueue.map((filename) => (
                <PreviewAttachment
                  attachment={{
                    url: "",
                    name: filename,
                    contentType: "",
                  }}
                  isUploading={true}
                  key={filename}
                />
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {/* ============================================================== */}
        {/* INPUT LAYER - Absolute positioned, anchored to bottom          */}
        {/* This never moves during transitions - key to smooth morphing   */}
        {/* ============================================================== */}
        <PromptInput
          className="absolute inset-x-0 bottom-0 flex flex-col border-none bg-transparent px-3 py-2 shadow-none"
          onSubmit={(event) => {
            event.preventDefault();
            submitForm();
          }}
          style={{ height: SURFACE_HEIGHTS.inputLayer }}
        >
          <PromptInputTextarea
            className="flex-1 resize-none border-0! border-none! bg-transparent px-3 py-2 text-[15px] leading-relaxed outline-none ring-0 [-ms-overflow-style:none] [scrollbar-width:none] placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 [&::-webkit-scrollbar]:hidden"
            data-testid="multimodal-input"
            disableAutoResize={true}
            maxHeight={200}
            minHeight={36}
            onChange={handleInput}
            placeholder={placeholder}
            ref={textareaRef}
            rows={1}
            value={input}
          />
          <PromptInputToolbar className="shrink-0 border-t-0! p-0 shadow-none">
            <PromptInputTools className="gap-0.5">
              <Button
                className="aspect-square h-8 rounded-lg p-1 transition-colors hover:bg-muted"
                data-testid="attachments-button"
                disabled={isSubmitting}
                onClick={(event) => {
                  event.preventDefault();
                  fileInputRef.current?.click();
                }}
                variant="ghost"
                type="button"
              >
                <PaperclipIcon size={14} style={{ width: 14, height: 14 }} />
              </Button>
            </PromptInputTools>

            {isSubmitting ? (
              <Button
                className="size-9 rounded-xl bg-foreground p-1 text-background transition-all duration-200 hover:bg-foreground/90 hover:scale-105 active:scale-95"
                data-testid="stop-button"
                onClick={(event) => {
                  event.preventDefault();
                  onStop?.();
                }}
                type="button"
              >
                <StopIcon size={14} />
              </Button>
            ) : (
              <PromptInputSubmit
                className="size-9 rounded-xl bg-linear-to-br from-primary to-primary/80 text-primary-foreground shadow-md shadow-primary/20 transition-all duration-200 hover:shadow-lg hover:shadow-primary/30 hover:scale-105 active:scale-95 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none disabled:from-muted disabled:to-muted"
                data-testid="send-button"
                disabled={!input.trim() && attachments.length === 0}
                isLoading={isSubmitting}
              >
                <ArrowUpIcon size={14} />
              </PromptInputSubmit>
            )}
          </PromptInputToolbar>
        </PromptInput>
      </motion.div>
    </div>
  );
}

export const MultimodalInput = memo(
  PureMultimodalInput,
  (prevProps, nextProps) => {
    if (prevProps.input !== nextProps.input) {
      return false;
    }
    if (prevProps.isSubmitting !== nextProps.isSubmitting) {
      return false;
    }
    if (prevProps.attachments !== nextProps.attachments) {
      return false;
    }
    if (prevProps.onSubmit !== nextProps.onSubmit) {
      return false;
    }

    return true;
  }
);
