/**
 * ShadCN UI React + TypeScript Reference Component
 *
 * This is a reference implementation showing how the ClaudeMarble overlay
 * would look if built with React, TypeScript, and ShadCN UI.
 *
 * NOTE: This is NOT used in the current vanilla JS implementation.
 * It's provided as a reference for future migration or inspiration.
 *
 * @requires react ^18.0.0
 * @requires @radix-ui/react-dialog
 * @requires class-variance-authority
 * @requires tailwindcss
 */

import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { cn } from "@/lib/utils"
import {
  Upload,
  Download,
  Trash2,
  Filter,
  Play,
  Pause,
  X,
  Minimize2,
  Maximize2,
  GripHorizontal,
} from "lucide-react"

/* ============================================
   SHADCN UI COMPONENTS
   ============================================ */

/**
 * Dialog Component (ShadCN Sheet/Dialog)
 * Based on Radix UI Dialog primitive
 */
const Dialog = DialogPrimitive.Root

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-background/80 backdrop-blur-sm",
      "data-[state=open]:animate-in data-[state=closed]:animate-out",
      "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

interface DialogContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  hideOverlay?: boolean
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(({ className, children, hideOverlay = false, ...props }, ref) => (
  <DialogPortal>
    {!hideOverlay && <DialogOverlay />}
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed z-50 gap-4 rounded-xl border bg-background p-6 shadow-xl",
        "data-[state=open]:animate-in data-[state=closed]:animate-out",
        "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
        "data-[state=closed]:slide-out-to-right-1/2 data-[state=closed]:slide-out-to-top-[48%]",
        "data-[state=open]:slide-in-from-right-1/2 data-[state=open]:slide-in-from-top-[48%]",
        className
      )}
      {...props}
    >
      {children}
    </DialogPrimitive.Content>
  </DialogPortal>
))
DialogContent.displayName = DialogPrimitive.Content.displayName

/**
 * Button Component (ShadCN Button)
 */
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link"
  size?: "default" | "sm" | "lg" | "icon"
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", ...props }, ref) => {
    return (
      <button
        className={cn(
          "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium",
          "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          "disabled:pointer-events-none disabled:opacity-50",
          {
            // Variants
            "bg-primary text-primary-foreground hover:bg-primary/90 shadow":
              variant === "default",
            "bg-destructive text-destructive-foreground hover:bg-destructive/90 shadow-sm":
              variant === "destructive",
            "border border-input bg-background hover:bg-accent hover:text-accent-foreground":
              variant === "outline",
            "bg-secondary text-secondary-foreground hover:bg-secondary/80":
              variant === "secondary",
            "hover:bg-accent hover:text-accent-foreground": variant === "ghost",
            "text-primary underline-offset-4 hover:underline": variant === "link",

            // Sizes
            "h-10 px-4 py-2": size === "default",
            "h-9 rounded-md px-3": size === "sm",
            "h-11 rounded-md px-8": size === "lg",
            "h-10 w-10": size === "icon",
          },
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

/**
 * Input Component (ShadCN Input)
 */
interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
          "ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium",
          "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2",
          "focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

/**
 * Textarea Component (ShadCN Textarea)
 */
interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          "flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
          "ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          "disabled:cursor-not-allowed disabled:opacity-50 resize-y font-mono",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Textarea.displayName = "Textarea"

/**
 * Card Component (ShadCN Card)
 */
const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "rounded-lg border bg-card text-card-foreground shadow-sm",
      className
    )}
    {...props}
  />
))
Card.displayName = "Card"

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-col space-y-1.5 p-6", className)}
    {...props}
  />
))
CardHeader.displayName = "CardHeader"

const CardTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h3
    ref={ref}
    className={cn(
      "text-2xl font-semibold leading-none tracking-tight",
      className
    )}
    {...props}
  />
))
CardTitle.displayName = "CardTitle"

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
))
CardContent.displayName = "CardContent"

/**
 * Separator Component (ShadCN Separator)
 */
const Separator = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("shrink-0 bg-border h-[1px] w-full", className)}
    {...props}
  />
))
Separator.displayName = "Separator"

/* ============================================
   CUSTOM TYPES
   ============================================ */

interface Coordinates {
  tileX: number
  tileY: number
  pixelX: number
  pixelY: number
}

interface Template {
  id: string
  name: string
  file: File
  coordinates: Coordinates
  isEnabled: boolean
}

/* ============================================
   MARBLE OVERLAY COMPONENT
   ============================================ */

interface MarbleOverlayProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  version?: string
}

export function MarbleOverlay({
  open = true,
  onOpenChange,
  version = "1.0.0",
}: MarbleOverlayProps) {
  const [isMinimized, setIsMinimized] = React.useState(false)
  const [isDragging, setIsDragging] = React.useState(false)
  const [position, setPosition] = React.useState({ x: 0, y: 0 })
  const [templates, setTemplates] = React.useState<Template[]>([])
  const [statusMessage, setStatusMessage] = React.useState(`Ready...\nVersion: ${version}`)

  // Form state
  const [coordinates, setCoordinates] = React.useState<Coordinates>({
    tileX: 0,
    tileY: 0,
    pixelX: 0,
    pixelY: 0,
  })
  const [selectedFile, setSelectedFile] = React.useState<File | null>(null)
  const [quickPaintCount, setQuickPaintCount] = React.useState(5)
  const [colorId, setColorId] = React.useState(25)
  const [isQuickPaintEnabled, setIsQuickPaintEnabled] = React.useState(false)
  const [isPaused, setIsPaused] = React.useState(false)

  // Drag functionality
  const dragRef = React.useRef<HTMLDivElement>(null)
  const overlayRef = React.useRef<HTMLDivElement>(null)

  const handleDragStart = (e: React.MouseEvent) => {
    if (e.target !== dragRef.current) return
    setIsDragging(true)

    const rect = overlayRef.current?.getBoundingClientRect()
    if (!rect) return

    const offsetX = e.clientX - rect.left
    const offsetY = e.clientY - rect.top

    const handleDrag = (e: MouseEvent) => {
      setPosition({
        x: e.clientX - offsetX,
        y: e.clientY - offsetY,
      })
    }

    const handleDragEnd = () => {
      setIsDragging(false)
      document.removeEventListener('mousemove', handleDrag)
      document.removeEventListener('mouseup', handleDragEnd)
    }

    document.addEventListener('mousemove', handleDrag)
    document.addEventListener('mouseup', handleDragEnd)
  }

  // Template management
  const handleUploadTemplate = () => {
    if (!selectedFile) {
      setStatusMessage("Error: No file selected!")
      return
    }

    if (!coordinates.tileX || !coordinates.tileY || !coordinates.pixelX || !coordinates.pixelY) {
      setStatusMessage("Error: Please fill in all coordinate fields!")
      return
    }

    const newTemplate: Template = {
      id: crypto.randomUUID(),
      name: selectedFile.name.replace(/\.[^/.]+$/, ""),
      file: selectedFile,
      coordinates: { ...coordinates },
      isEnabled: true,
    }

    setTemplates([...templates, newTemplate])
    setStatusMessage(`Status: Template "${newTemplate.name}" uploaded successfully!`)
    setSelectedFile(null)
  }

  const handleDeleteAll = () => {
    if (confirm("Delete all templates?")) {
      setTemplates([])
      setStatusMessage("Status: All templates deleted!")
    }
  }

  const handleDeleteSelected = () => {
    const enabledTemplates = templates.filter((t) => t.isEnabled)
    if (enabledTemplates.length === 0) {
      setStatusMessage("Error: No templates selected!")
      return
    }

    if (confirm(`Delete ${enabledTemplates.length} selected template(s)?`)) {
      setTemplates(templates.filter((t) => !t.isEnabled))
      setStatusMessage(`Status: ${enabledTemplates.length} template(s) deleted!`)
    }
  }

  const handleEnableAll = () => {
    setTemplates(templates.map((t) => ({ ...t, isEnabled: true })))
    setStatusMessage("Status: All templates enabled!")
  }

  const handleDisableAll = () => {
    setTemplates(templates.map((t) => ({ ...t, isEnabled: false })))
    setStatusMessage("Status: All templates disabled!")
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={overlayRef}
        hideOverlay
        className="fixed top-4 right-4 w-full max-w-md"
        style={{
          transform: `translate(${position.x}px, ${position.y}px)`,
        }}
      >
        {/* Drag Handle */}
        <div
          ref={dragRef}
          onMouseDown={handleDragStart}
          className={cn(
            "w-full h-1 rounded-full bg-muted mb-4 cursor-grab relative",
            "hover:bg-muted-foreground/50 transition-colors",
            isDragging && "cursor-grabbing bg-muted-foreground/70"
          )}
          role="button"
          aria-label="Drag to move overlay. Use arrow keys to reposition."
          tabIndex={0}
        >
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
            <GripHorizontal className="h-3 w-3 text-muted-foreground/30" />
          </div>
        </div>

        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-md bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white font-bold">
              M
            </div>
            <h1 className="text-xl font-semibold tracking-tight">ClaudeMarble</h1>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setIsMinimized(!isMinimized)}
            aria-label={isMinimized ? "Maximize overlay" : "Minimize overlay"}
            data-minimize
          >
            {isMinimized ? (
              <Maximize2 className="h-4 w-4" />
            ) : (
              <Minimize2 className="h-4 w-4" />
            )}
          </Button>
        </div>

        {!isMinimized && (
          <div className="flex flex-col gap-4">
            {/* Coordinates Section */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">📍 Coordinates</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-4 gap-2">
                  <Input
                    type="number"
                    placeholder="Tile X"
                    value={coordinates.tileX || ""}
                    onChange={(e) =>
                      setCoordinates({ ...coordinates, tileX: Number(e.target.value) })
                    }
                    aria-label="Tile X coordinate"
                  />
                  <Input
                    type="number"
                    placeholder="Tile Y"
                    value={coordinates.tileY || ""}
                    onChange={(e) =>
                      setCoordinates({ ...coordinates, tileY: Number(e.target.value) })
                    }
                    aria-label="Tile Y coordinate"
                  />
                  <Input
                    type="number"
                    placeholder="Pixel X"
                    value={coordinates.pixelX || ""}
                    onChange={(e) =>
                      setCoordinates({ ...coordinates, pixelX: Number(e.target.value) })
                    }
                    aria-label="Pixel X coordinate"
                  />
                  <Input
                    type="number"
                    placeholder="Pixel Y"
                    value={coordinates.pixelY || ""}
                    onChange={(e) =>
                      setCoordinates({ ...coordinates, pixelY: Number(e.target.value) })
                    }
                    aria-label="Pixel Y coordinate"
                  />
                </div>
              </CardContent>
            </Card>

            {/* Template Section */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">🎨 Template</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col gap-3">
                  <Input
                    type="file"
                    accept=".png,.jpg,.jpeg,.gif,.bmp,.webp"
                    onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                    aria-label="Upload template file"
                  />
                  <div className="grid grid-cols-3 gap-2">
                    <Button
                      onClick={handleUploadTemplate}
                      className="col-span-3"
                      disabled={!selectedFile}
                    >
                      <Upload className="h-4 w-4" />
                      Upload
                    </Button>
                    <Button variant="secondary" onClick={handleEnableAll}>
                      <Play className="h-4 w-4" />
                      Enable
                    </Button>
                    <Button variant="secondary" onClick={handleDisableAll}>
                      <Pause className="h-4 w-4" />
                      Disable
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => setIsPaused(!isPaused)}
                      className={cn(isPaused && "bg-green-100 hover:bg-green-200")}
                    >
                      {isPaused ? "Resume" : "Pause"}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Quick Paint Section */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">🎯 Quick Paint</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    placeholder="Count"
                    min={1}
                    max={1000}
                    value={quickPaintCount}
                    onChange={(e) => setQuickPaintCount(Number(e.target.value))}
                    className="w-20"
                    aria-label="Quick paint count"
                  />
                  <Input
                    type="number"
                    placeholder="Color ID"
                    min={1}
                    max={65}
                    value={colorId}
                    onChange={(e) => setColorId(Number(e.target.value))}
                    className="w-24"
                    aria-label="Color ID"
                  />
                  <Button
                    variant={isQuickPaintEnabled ? "destructive" : "default"}
                    onClick={() => setIsQuickPaintEnabled(!isQuickPaintEnabled)}
                    className="flex-1"
                  >
                    {isQuickPaintEnabled ? "Disable" : "Enable"}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Controls Section */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">⚙️ Controls</CardTitle>
              </CardHeader>
              <CardContent>
                <Button variant="outline" className="w-full">
                  <Filter className="h-4 w-4" />
                  Color Filter
                </Button>
              </CardContent>
            </Card>

            {/* Status Section */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">📋 Status</CardTitle>
              </CardHeader>
              <CardContent>
                <Textarea
                  value={statusMessage}
                  readOnly
                  className="min-h-[80px]"
                  aria-label="Status message"
                />
              </CardContent>
            </Card>

            {/* Action Buttons */}
            <div className="flex gap-2">
              <Button
                variant="destructive"
                onClick={handleDeleteAll}
                className="flex-1"
              >
                <Trash2 className="h-4 w-4" />
                Delete All
              </Button>
              <Button
                variant="destructive"
                onClick={handleDeleteSelected}
                className="flex-1"
              >
                <Trash2 className="h-4 w-4" />
                Delete Selected
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/* ============================================
   USAGE EXAMPLE
   ============================================ */

export default function App() {
  const [open, setOpen] = React.useState(true)

  return (
    <div className="min-h-screen bg-slate-50">
      <MarbleOverlay
        open={open}
        onOpenChange={setOpen}
        version="1.0.0"
      />
    </div>
  )
}
