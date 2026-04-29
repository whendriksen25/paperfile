import { UploadForm } from "@/components/upload/upload-form";

export default function UploadPage() {
  return (
    <div className="px-5 md:px-10 py-6 md:py-10 max-w-3xl mx-auto">
      <header className="mb-6">
        <h1 className="text-3xl font-extrabold tracking-tight">Scan it</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Photos, PDFs, or any document. Paperfile classifies, files, and turns
          it into action.
        </p>
      </header>
      <UploadForm />
    </div>
  );
}
