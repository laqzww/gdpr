# Enhanced DOCX Export Documentation

## Overview
The enhanced DOCX export functionality integrates the Colab notebook workflow into the web application to process hearing responses with proper formatting and CriticMarkup support.

## Process Flow

1. **Template Block Insertion**
   - The script first inserts template blocks (`scriptskabelon/blok.md`) under each H2 section
   - Blocks contain:
     - `### Forvaltningens svar`
     - `### Forslag om ændring af lokalplanen`
   - Blocks are only inserted if not already present or if section doesn't contain "### Forvaltningens svar"

2. **CriticMarkup Processing**
   - The script processes CriticMarkup syntax from the AI-generated content:
     - `{==highlighted text==}{>>comment with citations<<}`
   - These are converted to Word comments in the margin with proper formatting
   - Comments include hearing numbers and citations

3. **Document Structure**
   - Main title (starting with "forslag til") is excluded from TOC
   - Existing TOC is deleted and replaced with a new placeholder that preserves the original TOC formatting/style
   - Word is configured to update fields on open (so TOC refreshes automatically)
   - Headings maintain proper outline levels
   - Bold (`**text**`) and italic (`*text*`) formatting is preserved

## Files Involved

- `scripts/build_docx_enhanced.py` - Main enhanced script
- `scriptskabelon/blok.md` - Template block to insert
- `scriptskabelon/Bilag 6 Svar på henvendelser i høringsperioden.docx` - Word template
- `server.js` - API endpoint at `/api/build-docx`

## Usage

The export is triggered from the web interface when users click "Download DOCX" after selecting their preferred AI-generated summary. The process is automatic and produces a properly formatted Word document ready for further editing.

## Dependencies

- `python-docx >= 1.2.0` - Required for advanced Word document manipulation
