#!/usr/bin/env php
<?php
/**
 * PureCloud Automated Functional Test Suite (CLI Runner)
 * 
 * Usage:
 *   php test_suite.php
 *   php test_suite.php --json
 */
declare(strict_types=1);

require_once __DIR__ . '/src/bootstrap.php';

use Cloud\Auth;
use Cloud\FunctionalTestSuite;

Auth::startSession();

$isJson = in_array('--json', $argv ?? [], true);

if ($isJson) {
    $report = FunctionalTestSuite::run();
    echo json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE) . PHP_EOL;
    exit($report['overall_status'] === 'pass' ? 0 : 1);
}

// ANSI Color formatting
$cGreen  = "\033[32m";
$cRed    = "\033[31m";
$cYellow = "\033[33m";
$cBlue   = "\033[34m";
$cBold   = "\033[1m";
$cReset  = "\033[0m";

echo "{$cBold}{$cBlue}========================================================================{$cReset}\n";
echo "{$cBold}🧪 PureCloud - Automatisierte End-to-End Funktions-Test-Suite{$cReset}\n";
echo "{$cBold}{$cBlue}========================================================================{$cReset}\n";
echo "Führe alle Kernfunktionen in einer isolierten Sandbox aus...\n\n";

$report = FunctionalTestSuite::run();

foreach ($report['tests'] as $i => $t) {
    $num = str_pad((string)($i + 1), 2, ' ', STR_PAD_LEFT);
    $dur = str_pad(number_format((float)$t['duration_ms'], 2) . ' ms', 10, ' ', STR_PAD_LEFT);
    
    if ($t['status'] === 'pass') {
        $badge = "{$cGreen}[BESTANDEN]{$cReset}";
    } else {
        $badge = "{$cRed}[FEHLER]   {$cReset}";
    }

    echo "{$badge} #{$num} {$cBold}{$t['name']}{$cReset} ({$t['category']})\n";
    echo "           {$dur} | {$t['details']}\n\n";
}

$summary = $report['summary'];
$health = $summary['health_percent'];
$healthColor = $health === 100 ? $cGreen : ($health >= 80 ? $cYellow : $cRed);

echo "{$cBold}{$cBlue}========================================================================{$cReset}\n";
echo "{$cBold}ZUSAMMENFASSUNG:{$cReset}\n";
echo "Gesamttests: {$cBold}{$summary['total']}{$cReset} | ";
echo "Erfolgreich: {$cGreen}{$summary['passed']}{$cReset} | ";
echo "Fehlgeschlagen: " . ($summary['failed'] > 0 ? "{$cRed}{$summary['failed']}{$cReset}" : "0") . "\n";
echo "Integritäts-Score: {$healthColor}{$cBold}{$health}%{$cReset} | ";
echo "Gesamtlaufzeit: {$cBold}{$report['duration_ms']} ms{$cReset}\n";
echo "{$cBold}{$cBlue}========================================================================{$cReset}\n";

exit($report['overall_status'] === 'pass' ? 0 : 1);
