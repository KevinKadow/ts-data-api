param([Parameter(ValueFromRemainingArguments=$true)][string[]]$ToolArguments)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskState = if ($env:READER_DEPLOY_STATE) {$env:READER_DEPLOY_STATE} else {Join-Path $taskRoot '.deployment'}
$taskInput = if ($env:READER_DEPLOY_INPUT) {$env:READER_DEPLOY_INPUT} else {Join-Path $taskRoot 'deployment-input'}
$taskTransfer = if ($env:READER_DEPLOY_TRANSFER) {$env:READER_DEPLOY_TRANSFER} else {Join-Path $taskRoot 'deployment-transfer'}
$taskIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
foreach ($taskDirectory in @($taskState,$taskInput,$taskTransfer)) {
  New-Item -ItemType Directory -Force -Path $taskDirectory | Out-Null
  & icacls $taskDirectory /inheritance:r /grant:r "${taskIdentity}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE -ne 0) {throw 'Could not protect deployment directory ACLs'}
}
$taskState = (Resolve-Path -LiteralPath $taskState).Path
$taskInput = (Resolve-Path -LiteralPath $taskInput).Path
$taskTransfer = (Resolve-Path -LiteralPath $taskTransfer).Path
& docker build --target deployment-tools -t ts-data-api-deployment-tools $taskRoot
if ($LASTEXITCODE -ne 0) {throw 'Deployment tools image build failed'}
$taskRevision = (& git -C $taskRoot rev-parse --short HEAD).Trim()
if ($LASTEXITCODE -ne 0) {throw 'Cannot determine source revision'}
if (& git -C $taskRoot status --porcelain) {$taskRevision += '-dirty'}
$taskInteractive = if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) {'-i'} else {'-it'}
& docker run --rm $taskInteractive --cap-drop ALL --security-opt no-new-privileges:true `
  -e "DEPLOY_REVISION=$taskRevision" `
  -e DEPLOY_HOST_PLATFORM=windows `
  --mount "type=bind,source=$taskState,target=/state" `
  --mount "type=bind,source=$taskInput,target=/input,readonly" `
  --mount "type=bind,source=$taskTransfer,target=/transfer" `
  ts-data-api-deployment-tools @ToolArguments
if ($LASTEXITCODE -ne 0) {throw 'Deployment operation failed; see diagnostic above'}
