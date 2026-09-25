# The whole study on Windows PowerShell, resumable (finished steps are skipped). Same steps as run_all.sh.
#
#   powershell -ExecutionPolicy Bypass -File .\run_all.ps1 pilot            one seed, 3 variants, 100 prompts, contexts 0 and 1000
#   powershell -ExecutionPolicy Bypass -File .\run_all.ps1 full -Batch 64   three seeds, every variant, all 541 prompts, 0 to 6000
#   powershell -ExecutionPolicy Bypass -File .\run_all.ps1 smoke            plumbing check
#
# Uses .venv\Scripts\python.exe when it exists, so no activation is needed.
param(
    [ValidateSet('pilot', 'full', 'smoke')] [string]$Preset = 'pilot',
    [string]$Model = 'HuggingFaceTB/SmolLM2-135M-Instruct',
    [string]$Device = 'auto',
    [int]$Batch = 16,
    [string]$Out = '',
    [string]$TrainArgs = ''
)
$ErrorActionPreference = 'Continue'
$env:PYTHONUTF8 = '1'
Set-Location $PSScriptRoot
if (-not $Out) { $Out = "work/$Preset" }
$py = 'python'
if (Test-Path '.venv/Scripts/python.exe') { $py = (Resolve-Path '.venv/Scripts/python.exe').Path }

switch ($Preset) {
    'pilot' { $Prompts = 300;  $Samples = 2; $Passages = 20;  $Gen = 256; $Epochs = 1; $Seeds = @(0);       $Lengths = @(0, 1000);                   $Limit = 100; $MaxNew = 384;  $Variants = @('lora', 'ledger', 'ledger_joint') }
    'full'  { $Prompts = 3000; $Samples = 4; $Passages = 200; $Gen = 512; $Epochs = 2; $Seeds = @(0, 1, 2); $Lengths = @(0, 1000, 2000, 4000, 6000); $Limit = 0;   $MaxNew = 1024; $Variants = @('lora', 'ledger', 'ledger_joint', 'ledger_nogate') }
    'smoke' { $Prompts = 40;   $Samples = 2; $Passages = 4;   $Gen = 32;  $Epochs = 1; $Seeds = @(0);       $Lengths = @(0, 64);                     $Limit = 6;   $MaxNew = 16;   $Variants = @('lora', 'ledger', 'ledger_joint', 'ledger_nogate') }
}

function Invoke-Py([object[]]$argList) {
    $strings = @($argList | ForEach-Object { "$_" })
    Write-Host "> python $($strings -join ' ')"
    & $py @strings
    if ($LASTEXITCODE -ne 0) { throw "step failed (exit code $LASTEXITCODE): python $($strings -join ' ')" }
}

if (-not (Test-Path 'vendor/instruction_following_eval')) { Invoke-Py @('setup_ifeval.py') }
if (-not (Test-Path "$Out/data/train.jsonl")) {
    Invoke-Py @('data.py', '--model', $Model, '--device', $Device, '--out', "$Out/data", '--prompts', $Prompts, '--samples', $Samples,
                '--passages', $Passages, '--max-new-tokens', $Gen, '--batch-size', $Batch)
}
$extra = @()
if ($TrainArgs) { $extra = $TrainArgs -split '\s+' }
foreach ($seed in $Seeds) {
    foreach ($v in $Variants) {
        if (-not (Test-Path "$Out/runs/$v-s$seed/weights.pt")) {
            Invoke-Py (@('train.py', '--model', $Model, '--device', $Device, '--variant', $v, '--seed', $seed,
                         '--data', "$Out/data/train.jsonl", '--out', "$Out/runs", '--epochs', $Epochs) + $extra)
        }
    }
}
$last = $Lengths[-1]
$common = @('--lengths') + $Lengths + @('--limit', $Limit, '--max-new-tokens', $MaxNew, '--batch-size', $Batch,
                                        '--distractors', "$Out/data/distractors.jsonl", '--out', "$Out/results")
if (-not (Test-Path "$Out/results/base-L$last.jsonl")) {
    Invoke-Py (@('evaluate.py', '--model', $Model, '--device', $Device, '--variant', 'base') + $common)
}
foreach ($seed in $Seeds) {
    foreach ($v in $Variants) {
        if (-not (Test-Path "$Out/results/$v-s$seed-L$last.jsonl")) {
            Invoke-Py (@('evaluate.py', '--model', $Model, '--device', $Device, '--run', "$Out/runs/$v-s$seed") + $common)
        }
    }
}
Invoke-Py @('analyze.py', '--results', "$Out/results")
Write-Host "done: $Out/results/summary.md"
