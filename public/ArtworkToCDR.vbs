Option Explicit

Dim args, fso, svgPath, cdrPath, basePath, stamp, sourceFile, sourceText
Dim artworkOnly, widthPattern, heightPattern, viewBoxPattern, viewBoxMatch
Dim expectedWidth, expectedHeight, viewX, viewY, viewWidth, viewHeight
Dim corel, document, allShapes, textShapes, saveOptions, pageWidth, pageHeight
Dim shell, publicRoot, stagingFolder, stagedSvgPath, stagedCdrPath, importedShape, usableShapes

Sub Report(message, flags, title)
  If InStr(1, LCase(WScript.FullName), "cscript.exe", vbTextCompare) > 0 Then
    WScript.Echo title & ": " & message
  Else
    MsgBox message, flags, title
  End If
End Sub

Sub SafeQuitCorel()
  On Error Resume Next
  corel.Quit
  Err.Clear
  On Error GoTo 0
End Sub

Set args = WScript.Arguments
If args.Count = 0 Then
  Report "Drag an SVG downloaded from the leather label designer onto this helper.", 64, "Save as CDR"
  WScript.Quit 1
End If

svgPath = args(0)
Set fso = CreateObject("Scripting.FileSystemObject")
If Not fso.FileExists(svgPath) Then
  Report "The SVG file was not found.", 16, "Save as CDR"
  WScript.Quit 1
End If
If LCase(fso.GetExtensionName(svgPath)) <> "svg" Then
  Report "This helper accepts SVG files only.", 16, "Save as CDR"
  WScript.Quit 1
End If

Set sourceFile = fso.OpenTextFile(svgPath, 1)
sourceText = sourceFile.ReadAll
sourceFile.Close
artworkOnly = InStr(1, sourceText, "data-artwork-only=""true""", vbTextCompare) > 0

If Not artworkOnly Then
  Report "Rejected: this is not a pure black artwork file. Full label mockups, leather colors and stitch lines cannot be converted by the mold-artwork helper.", 16, "Save as CDR"
  WScript.Quit 1
End If
If InStr(1, sourceText, "data-export-profile=""leather-label-mold-artwork""", vbTextCompare) = 0 Or _
   InStr(1, sourceText, "data-export-version=""2""", vbTextCompare) = 0 Or _
   InStr(1, sourceText, "data-human-reviewed=""true""", vbTextCompare) = 0 Then
  Report "Rejected: the production export marker is missing or outdated. Download the pure artwork SVG again from the current leather label designer.", 16, "Save as CDR"
  WScript.Quit 1
End If
If InStr(1, sourceText, "<image", vbTextCompare) > 0 Or _
   InStr(1, sourceText, "<text", vbTextCompare) > 0 Or _
   InStr(1, sourceText, "<rect", vbTextCompare) > 0 Or _
   InStr(1, sourceText, "<line", vbTextCompare) > 0 Or _
   InStr(1, sourceText, "<use", vbTextCompare) > 0 Or _
   InStr(1, sourceText, "<style", vbTextCompare) > 0 Or _
   InStr(1, sourceText, "<script", vbTextCompare) > 0 Or _
   InStr(1, sourceText, "<foreignObject", vbTextCompare) > 0 Then
  Report "Rejected: mold artwork may contain groups and closed paths only. No CDR was saved.", 16, "Save as CDR"
  WScript.Quit 1
End If
If InStr(1, sourceText, "<path", vbTextCompare) = 0 Then
  Report "Rejected: the pure artwork file contains no curve paths.", 16, "Save as CDR"
  WScript.Quit 1
End If

If artworkOnly Then
  Set widthPattern = New RegExp
  widthPattern.Pattern = "width=""([0-9]+(\.[0-9]+)?)mm"""
  widthPattern.IgnoreCase = True
  Set heightPattern = New RegExp
  heightPattern.Pattern = "height=""([0-9]+(\.[0-9]+)?)mm"""
  heightPattern.IgnoreCase = True
  If Not widthPattern.Test(sourceText) Or Not heightPattern.Test(sourceText) Then
    Report "The artwork SVG has no millimeter page size. No CDR was saved.", 16, "Save as CDR"
    WScript.Quit 1
  End If
  expectedWidth = CDbl(widthPattern.Execute(sourceText)(0).SubMatches(0))
  expectedHeight = CDbl(heightPattern.Execute(sourceText)(0).SubMatches(0))
  If expectedWidth < 10 Or expectedWidth > 200 Or expectedHeight < 10 Or expectedHeight > 150 Then
    Report "The millimeter page size is outside the supported label range. No CDR was saved.", 16, "Save as CDR"
    WScript.Quit 1
  End If
  Set viewBoxPattern = New RegExp
  viewBoxPattern.Pattern = "viewBox=""[ ]*([-0-9.]+)[ ,]+([-0-9.]+)[ ,]+([0-9.]+)[ ,]+([0-9.]+)[ ]*"""
  viewBoxPattern.IgnoreCase = True
  If Not viewBoxPattern.Test(sourceText) Then
    Report "The artwork SVG has no valid millimeter viewBox. No CDR was saved.", 16, "Save as CDR"
    WScript.Quit 1
  End If
  Set viewBoxMatch = viewBoxPattern.Execute(sourceText)(0)
  viewX = CDbl(viewBoxMatch.SubMatches(0))
  viewY = CDbl(viewBoxMatch.SubMatches(1))
  viewWidth = CDbl(viewBoxMatch.SubMatches(2))
  viewHeight = CDbl(viewBoxMatch.SubMatches(3))
  If Abs(viewX) > 0.001 Or Abs(viewY) > 0.001 Or _
     Abs(viewWidth - expectedWidth) > 0.001 Or _
     Abs(viewHeight - expectedHeight) > 0.001 Then
    Report "The SVG viewBox does not match its millimeter page. No CDR was saved.", 16, "Save as CDR"
    WScript.Quit 1
  End If
  If InStr(1, sourceText, "<image", vbTextCompare) > 0 Or _
     InStr(1, sourceText, "<text", vbTextCompare) > 0 Then
    Report "Artwork-only SVG unexpectedly contains a bitmap or live text. No CDR was saved.", 16, "Save as CDR"
    WScript.Quit 1
  End If
End If

basePath = Left(svgPath, Len(svgPath) - 4)
cdrPath = basePath & "_CDR-REVIEW.cdr"
If fso.FileExists(cdrPath) Then
  stamp = Year(Now) & Right("0" & Month(Now), 2) & Right("0" & Day(Now), 2) & "-" & _
          Right("0" & Hour(Now), 2) & Right("0" & Minute(Now), 2) & Right("0" & Second(Now), 2)
  cdrPath = basePath & "_CDR-REVIEW_" & stamp & ".cdr"
End If

' The SVG importer in CorelDRAW 2020 can silently lose paths when its source
' directory contains non-ASCII characters. Import from a temporary ASCII path.
Set shell = CreateObject("WScript.Shell")
publicRoot = shell.ExpandEnvironmentStrings("%PUBLIC%")
If Not fso.FolderExists(publicRoot) Then
  Report "A temporary import folder is unavailable. No CDR was saved.", 16, "Save as CDR"
  WScript.Quit 1
End If
Randomize
stagingFolder = fso.BuildPath(publicRoot, "LeatherLabel-" & Year(Now) & _
  Right("0" & Month(Now), 2) & Right("0" & Day(Now), 2) & "-" & _
  Right("000000" & CStr(Int(Rnd * 1000000)), 6))
On Error Resume Next
fso.CreateFolder stagingFolder
If Err.Number <> 0 Then
  Report "Could not create a temporary import folder. No CDR was saved.", 16, "Save as CDR"
  WScript.Quit 1
End If
On Error GoTo 0
stagedSvgPath = fso.BuildPath(stagingFolder, "artwork.svg")
stagedCdrPath = fso.BuildPath(stagingFolder, "artwork.cdr")
fso.CopyFile svgPath, stagedSvgPath, False

On Error Resume Next
Set corel = CreateObject("CorelDRAW.Application.22")
If Err.Number <> 0 Then
  Report "CorelDRAW 2020 could not be started.", 16, "Save as CDR"
  fso.DeleteFolder stagingFolder, True
  WScript.Quit 1
End If
On Error GoTo 0
corel.Visible = False

On Error Resume Next
Set document = corel.OpenDocument(stagedSvgPath)
If Err.Number <> 0 Then
  Report "CorelDRAW could not open the SVG.", 16, "Save as CDR"
  SafeQuitCorel
  fso.DeleteFolder stagingFolder, True
  WScript.Quit 1
End If
On Error GoTo 0

' CorelDRAW unit 3 is millimeters. Never fit artwork-only pages to path bounds:
' doing so changes the true label size and every artwork margin.
document.Unit = 3
Set allShapes = document.ActivePage.Shapes.All
usableShapes = 0
For Each importedShape In allShapes
  If importedShape.SizeWidth > 0.01 Or importedShape.SizeHeight > 0.01 Then
    usableShapes = usableShapes + 1
  End If
Next
If usableShapes = 0 Then
  Report "No editable artwork was imported. No CDR was saved.", 16, "Save as CDR"
  document.Close
  SafeQuitCorel
  fso.DeleteFolder stagingFolder, True
  WScript.Quit 1
End If

If artworkOnly Then
  ' SVG opens on CorelDRAW's default A4 page. Resizing the page keeps the
  ' imported path positions relative to the SVG origin; centering shapes does not.
  document.ActivePage.SetSize expectedWidth, expectedHeight
  pageWidth = Round(document.ActivePage.SizeWidth, 3)
  pageHeight = Round(document.ActivePage.SizeHeight, 3)
  If Abs(pageWidth - expectedWidth) > 0.1 Or Abs(pageHeight - expectedHeight) > 0.1 Then
    Report "CorelDRAW did not preserve the SVG page size (expected " & expectedWidth & " x " & expectedHeight & " mm). No CDR was saved. Import manually and verify artwork margins.", 16, "Save as CDR"
    document.Close
    SafeQuitCorel
    fso.DeleteFolder stagingFolder, True
    WScript.Quit 1
  End If
  For Each importedShape In allShapes
    If importedShape.SizeWidth > 0.01 Or importedShape.SizeHeight > 0.01 Then
      If importedShape.LeftX < -0.1 Or importedShape.RightX > pageWidth + 0.1 Or _
         importedShape.BottomY < -0.1 Or importedShape.TopY > pageHeight + 0.1 Then
        Report "Imported artwork falls outside the millimeter page. No CDR was saved.", 16, "Save as CDR"
        document.Close
        SafeQuitCorel
        fso.DeleteFolder stagingFolder, True
        WScript.Quit 1
      End If
    End If
  Next
End If

Set textShapes = document.ActivePage.Shapes.FindShapes("", 6)
If artworkOnly And textShapes.Count > 0 Then
  Report "Artwork-only SVG imported live text. No CDR was saved.", 16, "Save as CDR"
  document.Close
  SafeQuitCorel
  fso.DeleteFolder stagingFolder, True
  WScript.Quit 1
End If
If textShapes.Count > 0 Then
  Report "Live text was found after import. No CDR was saved.", 16, "Save as CDR"
  document.Close
  SafeQuitCorel
  fso.DeleteFolder stagingFolder, True
  WScript.Quit 1
End If

Set saveOptions = corel.CreateStructSaveAsOptions()
saveOptions.Overwrite = False
document.SaveAs stagedCdrPath, saveOptions
document.Close
SafeQuitCorel
fso.MoveFile stagedCdrPath, cdrPath
fso.DeleteFolder stagingFolder, True

Report "CDR saved: " & vbCrLf & cdrPath & vbCrLf & _
       "Page: " & pageWidth & " x " & pageHeight & " mm" & vbCrLf & _
       "Verify every letter and artwork margin before making a mold.", 64, "Save complete"
