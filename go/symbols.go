package inillucent

import (
	"fmt"

	"github.com/ebitengine/purego"
)

// bindSymbols resolves every symbol out of the loaded library into the call
// table.
//
// A missing symbol is named in the error rather than left to fail at the call,
// because a library that is older than it claims otherwise announces itself as a
// crash somewhere unrelated.
//
// @param calls - the table to fill in
// @param handle - the loaded library
func bindSymbols(calls *driverCalls, handle uintptr) error {
	wanted := []struct {
		into any
		name string
	}{
		{&calls.abiVersion, "inillucent_abi_version"},
		{&calls.version, "inillucent_version"},
		{&calls.capabilityCount, "inillucent_capability_count"},
		{&calls.capability, "inillucent_capability"},
		{&calls.supports, "inillucent_supports"},

		{&calls.open, "inillucent_open"},
		{&calls.closeDatabase, "inillucent_close"},
		{&calls.checkpoint, "inillucent_checkpoint"},
		{&calls.integrityCheck, "inillucent_integrity_check"},
		{&calls.backupTo, "inillucent_backup_to"},
		{&calls.pathOf, "inillucent_path"},

		{&calls.connect, "inillucent_connect"},
		{&calls.connFree, "inillucent_conn_free"},
		{&calls.execute, "inillucent_execute"},
		{&calls.executeBatch, "inillucent_execute_batch"},
		{&calls.lastInsertRowid, "inillucent_last_insert_rowid"},
		{&calls.totalChanges, "inillucent_total_changes"},
		{&calls.inTransaction, "inillucent_in_transaction"},
		{&calls.schemaCookie, "inillucent_schema_cookie"},
		{&calls.cancel, "inillucent_cancel"},

		{&calls.prepare, "inillucent_prepare"},
		{&calls.stmtFree, "inillucent_stmt_free"},
		{&calls.bindNull, "inillucent_bind_null"},
		{&calls.bindInt, "inillucent_bind_int"},
		{&calls.bindReal, "inillucent_bind_real"},
		{&calls.bindText, "inillucent_bind_text"},
		{&calls.bindBlob, "inillucent_bind_blob"},
		{&calls.clearBindings, "inillucent_clear_bindings"},
		{&calls.stmtExecute, "inillucent_stmt_execute"},

		{&calls.rowsFree, "inillucent_rows_free"},
		{&calls.rowsColumnCount, "inillucent_rows_column_count"},
		{&calls.rowsColumnName, "inillucent_rows_column_name"},
		{&calls.rowsColumnType, "inillucent_rows_column_type"},
		{&calls.rowsCount, "inillucent_rows_count"},
		{&calls.rowsTotal, "inillucent_rows_total"},
		{&calls.rowsMore, "inillucent_rows_more"},
		{&calls.rowsAffected, "inillucent_rows_affected"},
		{&calls.rowsElapsedUs, "inillucent_rows_elapsed_us"},
		{&calls.rowsTag, "inillucent_rows_tag"},
		{&calls.valueType, "inillucent_value_type"},
		{&calls.valueInt, "inillucent_value_int"},
		{&calls.valueReal, "inillucent_value_real"},
		{&calls.valueBytes, "inillucent_value_bytes"},

		{&calls.txnBegin, "inillucent_txn_begin"},
		{&calls.txnExecute, "inillucent_txn_execute"},
		{&calls.txnCommit, "inillucent_txn_commit"},
		{&calls.txnRollback, "inillucent_txn_rollback"},

		{&calls.errorStatus, "inillucent_error_status"},
		{&calls.errorMessage, "inillucent_error_message"},
		{&calls.errorFeature, "inillucent_error_feature"},
		{&calls.errorDetail, "inillucent_error_detail"},
		{&calls.errorOffset, "inillucent_error_offset"},
		{&calls.errorFree, "inillucent_error_free"},
	}

	for _, symbol := range wanted {
		if err := bindOne(symbol.into, handle, symbol.name); err != nil {
			return err
		}
	}
	return nil
}

// bindOne resolves a single symbol, turning purego's panic into an error that
// names the symbol.
//
// @param into - a pointer to the function field being filled in
// @param handle - the loaded library
// @param name - the exported symbol name
func bindOne(into any, handle uintptr, name string) (err error) {
	defer func() {
		if why := recover(); why != nil {
			err = fmt.Errorf(
				"the driver does not export %s: %v. That symbol is in the ABI this package "+
					"was written for, so the library is either older than it claims or is not "+
					"the inillucent driver", name, why,
			)
		}
	}()
	purego.RegisterLibFunc(into, handle, name)
	return nil
}
