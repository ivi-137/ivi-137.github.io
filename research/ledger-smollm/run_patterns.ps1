# The house-pattern study (patterns.py) on Windows PowerShell, resumable (finished steps are skipped). Same steps as run_patterns.sh.
#
#   powershell -ExecutionPolicy Bypass -File .\run_patterns.ps1 pilot            one seed, 3 variants, 20 test prompts per n, contexts 0 and 2000
#   powershell -ExecutionPolicy Bypass -File .\run_patterns.ps1 full -Batch 64   three seeds, every variant, 75 per n, contexts 0, 2000 and 6000
#   powershell -ExecutionPolicy Bypass -File .\run_patterns.ps1 smoke            plumbing check
#
# -Distractors reuses background passages from a file (e.g. work/pilot/data/distractors.jsonl from run_all.ps1).
# Uses .venv\Scripts\python.exe when it exists, so no activation is needed.
param(
    [ValidateSet('pilot', 'full', 'smoke')] [string]$Preset = 'pilot',
    [string]$Model = 'HuggingFaceTB/SmolLM2-135M-Instruct',
    [string]$Device = 'auto',
    [int]$Batch = 16,
    [string]$Out = '',
    [string]$TrainArgs = '',
    [string]$Distractors = ''
)
$ErrorActionPreference = 'Continue'
$env:PYTHONUTF8 = '1'
Set-Location $PSScriptRoot
if (-not $Out) { $Out = "work/patterns-$Preset" }
$py = 'python'
if (Test-Path '.venv/Scripts/python.exe') { $py = (Resolve-Path '.venv/Scripts/python.exe').Path }

switch ($Preset) {
    'pilot' { $Prompts = 400;  $PerTopic = 2; $Samples = 1; $Passages = 20;  $Topics = 0; $Test = 20; $Epochs = 1; $Seeds = @(0);       $Lengths = @(0, 2000);       $MaxNew = 768;  $Variants = @('lora', 'ledger', 'ledger_joint') }
    'full'  { $Prompts = 3000; $PerTopic = 4; $Samples = 2; $Passages = 200; $Topics = 0; $Test = 75; $Epochs = 2; $Seeds = @(0, 1, 2); $Lengths = @(0, 2000, 6000); $MaxNew = 1024; $Variants = @('lora', 'ledger', 'ledger_joint', 'ledger_nogate') }
    'smoke' { $Prompts = 40;   $PerTopic = 2; $Samples = 1; $Passages = 4;   $Topics = 8; $Test = 2;  $Epochs = 1; $Seeds = @(0);       $Lengths = @(0, 64);         $MaxNew = 24;   $Variants = @('lora', 'ledger', 'ledger_joint', 'ledger_nogate') }
}
$Gen = 640
$dataExtra = @()
if ($Preset -eq 'smoke') { $Gen = 48; $dataExtra += '--stand-ins' }  # a random-weight stand-in writes no lists
if ($Distractors) { $dataExtra += @('--distractors', $Distractors) }

function Invoke-Py([object[]]$argList) {
    $strings = @($argList | ForEach-Object { "$_" })
    Write-Host "> python $($strings -join ' ')"
    & $py @strings
    if ($LASTEXITCODE -ne 0) { throw "step failed (exit code $LASTEXITCODE): python $($strings -join ' ')" }
}

if (-not (Test-Path "$Out/data/train.jsonl")) {
    Invoke-Py (@('pattern_data.py', '--model', $Model, '--device', $Device, '--out', "$Out/data", '--prompts', $Prompts, '--per-topic', $PerTopic,
                 '--samples', $Samples, '--passages', $Passages, '--topics', $Topics, '--test-per-n', $Test, '--max-new-tokens', $Gen,
                 '--batch-size', $Batch) + $dataExtra)
}
$extra = @()
if ($TrainArgs) { $extra = $TrainArgs -split '\s+' }
foreach ($seed in $Seeds) {
    foreach ($v in $Variants) {
        if (-not (Test-Path "$Out/runs/$v-s$seed/weights.pt")) {
            Invoke-Py (@('train.py', '--model', $Model, '--device', $Device, '--variant', $v, '--seed', $seed, '--spec', 'patterns',
                         '--data', "$Out/data/train.jsonl", '--out', "$Out/runs", '--epochs', $Epochs) + $extra)
        }
    }
}
$last = $Lengths[-1]
$common = @('--lengths') + $Lengths + @('--max-new-tokens', $MaxNew, '--batch-size', $Batch, '--test', "$Out/data/test.jsonl",
                                        '--distractors', "$Out/data/distractors.jsonl", '--out', "$Out/results")
if (-not (Test-Path "$Out/results/base-L$last.jsonl")) {
    Invoke-Py (@('pattern_eval.py', '--model', $Model, '--device', $Device, '--variant', 'base') + $common)
}
foreach ($seed in $Seeds) {
    foreach ($v in $Variants) {
        if (-not (Test-Path "$Out/results/$v-s$seed-L$last.jsonl")) {
            Invoke-Py (@('pattern_eval.py', '--model', $Model, '--device', $Device, '--run', "$Out/runs/$v-s$seed") + $common)
        }
    }
}
Invoke-Py @('pattern_analyze.py', '--results', "$Out/results")
Write-Host "done: $Out/results/summary.md"
