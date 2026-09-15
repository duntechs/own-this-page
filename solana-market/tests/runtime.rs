//! These tests execute the compiled .so in LiteSVM, including system-program
//! CPIs, rent, transaction signatures and rollback. No public RPC is contacted.
use litesvm::{types::TransactionResult, LiteSVM};
use solana_sdk::{
    account::Account,
    instruction::{AccountMeta, Instruction, InstructionError},
    message::Message,
    pubkey::Pubkey,
    rent::Rent,
    signature::{Keypair, Signer},
    system_program,
    transaction::{Transaction, TransactionError},
};
use slot_market::{
    slot_address, Content, MarketError, MarketInstruction, SlotState, BASE_PRICES,
    MAGIC, SLOT_COUNT, STATE_LEN, TREASURY,
};

const SMALL_SLOT: u16 = 18;
const LARGE_SLOT: u16 = 11;
const FUNDS: u64 = 30_000_000_000;

struct Fixture {
    svm: LiteSVM,
    program: Pubkey,
}

fn content(text: &str) -> Content {
    Content {
        text: text.to_owned(),
        image: "https://example.com/ad.png".to_owned(),
        link: "https://example.com/campaign".to_owned(),
    }
}

impl Fixture {
    fn new() -> Self {
        let program = Pubkey::new_unique();
        let mut svm = LiteSVM::new();
        let path = std::env::var("SLOT_MARKET_SO").unwrap_or_else(|_| {
            format!("{}/target/deploy/slot_market.so", env!("CARGO_MANIFEST_DIR"))
        });
        svm.add_program_from_file(program, &path)
            .unwrap_or_else(|error| panic!("build the SBF artifact first ({path}): {error:?}"));
        svm.airdrop(&TREASURY, FUNDS).unwrap();
        Self { svm, program }
    }

    fn actor(&mut self) -> Keypair {
        let actor = Keypair::new();
        self.svm.airdrop(&actor.pubkey(), FUNDS).unwrap();
        actor
    }

    fn address(&self, id: u16) -> Pubkey {
        slot_address(&self.program, id).0
    }

    fn state(&self, id: u16) -> SlotState {
        self.svm
            .get_account(&self.address(id))
            .map(|account| {
                if account.owner == system_program::id() && account.data.is_empty() {
                    SlotState::unclaimed(id)
                } else {
                    SlotState::unpack(&account.data).unwrap()
                }
            })
            .unwrap_or_else(|| SlotState::unclaimed(id))
    }

    fn balance(&self, address: &Pubkey) -> u64 {
        self.svm.get_account(address).map_or(0, |account| account.lamports)
    }

    fn instruction(&self, actor: Pubkey, id: u16, data: Vec<u8>) -> Instruction {
        Instruction {
            program_id: self.program,
            accounts: vec![
                AccountMeta::new(actor, true),
                AccountMeta::new(self.address(id), false),
                AccountMeta::new(TREASURY, false),
                AccountMeta::new_readonly(system_program::id(), false),
            ],
            data,
        }
    }

    fn buy_data(&self, state: &SlotState, value: Content) -> Vec<u8> {
        MarketInstruction::Buy {
            id: state.id,
            expected_owner: state.owner,
            expected_paid: state.paid,
            expected_version: state.version,
            payment: state.price().unwrap(),
            content: value,
        }
        .pack()
    }

    fn send(&mut self, actor: &Keypair, instruction: Instruction) -> TransactionResult {
        self.svm.expire_blockhash();
        let transaction = Transaction::new_signed_with_payer(
            &[instruction],
            Some(&actor.pubkey()),
            &[actor],
            self.svm.latest_blockhash(),
        );
        self.svm.send_transaction(transaction)
    }

    fn send_sponsored(&mut self, actor: &Keypair, payer: &Keypair, instruction: Instruction) -> TransactionResult {
        self.svm.expire_blockhash();
        let transaction = Transaction::new_signed_with_payer(
            &[instruction], Some(&payer.pubkey()), &[payer, actor], self.svm.latest_blockhash(),
        );
        self.svm.send_transaction(transaction)
    }

    fn buy(&mut self, actor: &Keypair, id: u16) -> TransactionResult {
        let state = self.state(id);
        let instruction = self.instruction(actor.pubkey(), id, self.buy_data(&state, content("Purchased")));
        self.send(actor, instruction)
    }

    fn edit(&mut self, actor: &Keypair, id: u16, value: Content) -> TransactionResult {
        let instruction = self.instruction(
            actor.pubkey(),
            id,
            MarketInstruction::Edit { id, expected_version: self.state(id).version, content: value }.pack(),
        );
        self.send(actor, instruction)
    }

    /// Only successful fixed-admin fixtures use this method. The supplied
    /// treasury key is public; its private key is intentionally unavailable.
    /// Disable simulator signature verification for this transaction alone,
    /// while still passing a real runtime signer flag to the program. Ordinary
    /// buy/edit/negative-signature tests use cryptographic verification.
    fn admin_fixture(&mut self, instruction: Instruction) -> TransactionResult {
        self.svm.expire_blockhash();
        let message = Message::new_with_blockhash(
            &[instruction], Some(&TREASURY), &self.svm.latest_blockhash(),
        );
        let mut transaction = Transaction::new_unsigned(message);
        // LiteSVM keys transaction history by signature. A fresh non-admin
        // fixture signature avoids treating every unsigned admin simulation as
        // the same all-zero signature. It is intentionally NOT a valid admin
        // signature and is accepted only while this fixture disables sigverify.
        transaction.signatures[0] = Keypair::new().sign_message(&transaction.message_data());
        self.svm = self.svm.clone().with_sigverify(false);
        let result = self.svm.send_transaction(transaction);
        self.svm = self.svm.clone().with_sigverify(true);
        result
    }

    fn moderate(&mut self, id: u16, locked: bool, value: Content) -> TransactionResult {
        let instruction = self.instruction(
            TREASURY,
            id,
            MarketInstruction::AdminEdit {
                id, expected_version: self.state(id).version, locked, content: value,
            }.pack(),
        );
        self.admin_fixture(instruction)
    }
}

fn assert_error(result: TransactionResult, expected: MarketError) {
    let error = result.expect_err("transaction must be rejected");
    assert_eq!(
        error.err,
        TransactionError::InstructionError(0, InstructionError::Custom(expected as u32)),
        "unexpected failure; runtime logs: {:?}", error.meta.logs,
    );
}

#[test]
fn first_purchase_creates_rent_exempt_pda_and_routes_exact_sol_to_treasury() {
    let mut fixture = Fixture::new();
    let buyer = fixture.actor();
    let treasury_before = fixture.balance(&TREASURY);
    let buyer_before = fixture.balance(&buyer.pubkey());
    let result = fixture.buy(&buyer, SMALL_SLOT).unwrap();
    let state = fixture.state(SMALL_SLOT);
    let account = fixture.svm.get_account(&fixture.address(SMALL_SLOT)).unwrap();
    assert_eq!(state.owner, buyer.pubkey());
    assert_eq!(state.paid, 100_000_000);
    assert_eq!(state.version, 1);
    assert!(!state.locked);
    assert_eq!(state.content, content("Purchased"));
    assert_eq!(account.owner, fixture.program);
    assert_eq!(account.data.len(), STATE_LEN);
    assert_eq!(&account.data[..8], MAGIC);
    let rent = fixture.svm.get_sysvar::<Rent>().minimum_balance(STATE_LEN);
    assert_eq!(account.lamports, rent);
    assert_eq!(fixture.balance(&TREASURY) - treasury_before, 100_000_000);
    assert_eq!(buyer_before - fixture.balance(&buyer.pubkey()), 100_000_000 + rent + 5_000);
    assert!(result.compute_units_consumed < 200_000);
}

#[test]
fn biggest_slot_starts_at_two_sol_and_every_slot_price_is_in_approved_range() {
    assert_eq!(SLOT_COUNT, 62);
    assert_eq!(BASE_PRICES.iter().min(), Some(&100_000_000));
    assert_eq!(BASE_PRICES.iter().max(), Some(&2_000_000_000));
    assert!(BASE_PRICES.iter().all(|price| price % 1_000_000 == 0));
    let mut fixture = Fixture::new();
    let buyer = fixture.actor();
    fixture.buy(&buyer, LARGE_SLOT).unwrap();
    assert_eq!(fixture.state(LARGE_SLOT).paid, 2_000_000_000);
}

#[test]
fn all_62_catalog_prices_are_enforced_by_the_compiled_program() {
    let mut fixture = Fixture::new();
    let buyer = fixture.actor();
    // Each space needs its own rent-exempt account as well as its initial price.
    let rent = fixture.svm.get_sysvar::<Rent>().minimum_balance(STATE_LEN);
    let required = BASE_PRICES.iter().sum::<u64>() + SLOT_COUNT as u64 * (rent + 5_000);
    fixture.svm.airdrop(&buyer.pubkey(), required).unwrap();
    for (id, expected_price) in BASE_PRICES.iter().enumerate() {
        let treasury_before = fixture.balance(&TREASURY);
        fixture.buy(&buyer, id as u16).unwrap();
        let state = fixture.state(id as u16);
        assert_eq!(state.owner, buyer.pubkey(), "slot {id}");
        assert_eq!(state.paid, *expected_price, "slot {id}");
        assert_eq!(fixture.balance(&TREASURY) - treasury_before, *expected_price, "slot {id}");
    }
}

#[test]
fn highest_valid_slot_61_supports_purchase_edit_and_takeover() {
    let mut fixture = Fixture::new();
    let first = fixture.actor();
    let second = fixture.actor();
    let last_id = 61;
    fixture.buy(&first, last_id).unwrap();
    fixture.edit(&first, last_id, content("Last space, first owner")).unwrap();
    assert_eq!(fixture.state(last_id).content.text, "Last space, first owner");
    let first_balance = fixture.balance(&first.pubkey());
    let treasury_before = fixture.balance(&TREASURY);
    fixture.buy(&second, last_id).unwrap();
    let state = fixture.state(last_id);
    assert_eq!(state.owner, second.pubkey());
    assert_eq!(state.paid, BASE_PRICES[61] * 2);
    assert_eq!(fixture.balance(&TREASURY) - treasury_before, BASE_PRICES[61] * 2);
    assert_eq!(fixture.balance(&first.pubkey()), first_balance, "previous owner receives no payout");
}

#[test]
fn takeover_doubles_price_pays_only_treasury_and_replaces_owner_content() {
    let mut fixture = Fixture::new();
    let first = fixture.actor();
    let second = fixture.actor();
    fixture.buy(&first, SMALL_SLOT).unwrap();
    let old_owner_balance = fixture.balance(&first.pubkey());
    let treasury_before = fixture.balance(&TREASURY);
    let old = fixture.state(SMALL_SLOT);
    let instruction = fixture.instruction(second.pubkey(), SMALL_SLOT, fixture.buy_data(&old, content("New ad")));
    fixture.send(&second, instruction).unwrap();
    let state = fixture.state(SMALL_SLOT);
    assert_eq!(state.owner, second.pubkey());
    assert_eq!(state.paid, 200_000_000);
    assert_eq!(state.version, 2);
    assert_eq!(state.price().unwrap(), 400_000_000);
    assert_eq!(state.content.text, "New ad");
    assert_eq!(fixture.balance(&TREASURY) - treasury_before, 200_000_000);
    assert_eq!(fixture.balance(&first.pubkey()), old_owner_balance, "old owner receives no payout");
}

#[test]
fn stale_purchase_quote_cannot_overwrite_a_concurrent_purchase() {
    let mut fixture = Fixture::new();
    let first = fixture.actor();
    let second = fixture.actor();
    let stale = fixture.buy_data(&fixture.state(SMALL_SLOT), content("Stale"));
    fixture.buy(&first, SMALL_SLOT).unwrap();
    let state_before = fixture.state(SMALL_SLOT);
    let treasury_before = fixture.balance(&TREASURY);
    let instruction = fixture.instruction(second.pubkey(), SMALL_SLOT, stale);
    assert_error(fixture.send(&second, instruction), MarketError::StaleQuote);
    assert_eq!(fixture.state(SMALL_SLOT), state_before);
    assert_eq!(fixture.balance(&TREASURY), treasury_before);
}

#[test]
fn stale_owner_paid_and_version_are_each_checked() {
    let mut fixture = Fixture::new();
    let first = fixture.actor();
    let second = fixture.actor();
    fixture.buy(&first, SMALL_SLOT).unwrap();
    let state = fixture.state(SMALL_SLOT);
    for field in 0..3 {
        let mut quote = state.clone();
        match field {
            0 => quote.owner = Pubkey::new_unique(),
            1 => quote.paid += 1,
            _ => quote.version += 1,
        }
        let instruction = fixture.instruction(second.pubkey(), SMALL_SLOT, fixture.buy_data(&quote, content("Bad quote")));
        assert_error(fixture.send(&second, instruction), MarketError::StaleQuote);
        assert_eq!(fixture.state(SMALL_SLOT), state);
    }
}

#[test]
fn overpayment_and_underpayment_reject_without_creating_or_funding_slot() {
    let mut fixture = Fixture::new();
    let buyer = fixture.actor();
    let before = fixture.balance(&TREASURY);
    for payment in [0, 99_999_999, 100_000_001] {
        let instruction = fixture.instruction(buyer.pubkey(), SMALL_SLOT, MarketInstruction::Buy {
            id: SMALL_SLOT, expected_owner: Pubkey::default(), expected_paid: 0,
            expected_version: 0, payment, content: content("Wrong amount"),
        }.pack());
        assert_error(fixture.send(&buyer, instruction), MarketError::WrongPayment);
        assert!(fixture.svm.get_account(&fixture.address(SMALL_SLOT)).is_none());
        assert_eq!(fixture.balance(&TREASURY), before);
    }
}

#[test]
fn owner_edit_costs_no_slot_fee_preserves_ownership_price_and_invalidates_old_quote() {
    let mut fixture = Fixture::new();
    let owner = fixture.actor();
    fixture.buy(&owner, SMALL_SLOT).unwrap();
    let before = fixture.state(SMALL_SLOT);
    let balance = fixture.balance(&TREASURY);
    fixture.edit(&owner, SMALL_SLOT, content("Updated" )).unwrap();
    let after = fixture.state(SMALL_SLOT);
    assert_eq!(after.owner, before.owner);
    assert_eq!(after.paid, before.paid);
    assert_eq!(after.version, before.version + 1);
    assert_eq!(after.content, content("Updated"));
    assert_eq!(fixture.balance(&TREASURY), balance);
    let instruction = fixture.instruction(owner.pubkey(), SMALL_SLOT, MarketInstruction::Edit {
        id: SMALL_SLOT, expected_version: before.version, content: content("Stale edit"),
    }.pack());
    assert_error(fixture.send(&owner, instruction), MarketError::StaleQuote);
    assert_eq!(fixture.state(SMALL_SLOT), after);
}

#[test]
fn former_owner_and_stranger_cannot_edit_or_moderate() {
    let mut fixture = Fixture::new();
    let old = fixture.actor();
    let current = fixture.actor();
    let stranger = fixture.actor();
    fixture.buy(&old, SMALL_SLOT).unwrap();
    fixture.buy(&current, SMALL_SLOT).unwrap();
    let state = fixture.state(SMALL_SLOT);
    assert_error(fixture.edit(&old, SMALL_SLOT, content("Old owner")), MarketError::NotOwner);
    assert_error(fixture.edit(&stranger, SMALL_SLOT, content("Stranger")), MarketError::NotOwner);
    let instruction = fixture.instruction(stranger.pubkey(), SMALL_SLOT, MarketInstruction::AdminEdit {
        id: SMALL_SLOT, expected_version: state.version, locked: true, content: Content::default(),
    }.pack());
    assert_error(fixture.send(&stranger, instruction), MarketError::NotAdmin);
    assert_eq!(fixture.state(SMALL_SLOT), state);
}

#[test]
fn missing_actor_signature_is_rejected_by_program() {
    let mut fixture = Fixture::new();
    let actor = fixture.actor();
    let payer = fixture.actor();
    let mut instruction = fixture.instruction(actor.pubkey(), SMALL_SLOT, fixture.buy_data(&fixture.state(SMALL_SLOT), content("Unsigned")));
    instruction.accounts[0].is_signer = false;
    assert_error(fixture.send(&payer, instruction), MarketError::MissingSignature);
    assert!(fixture.svm.get_account(&fixture.address(SMALL_SLOT)).is_none());
}

#[test]
fn forged_signature_is_rejected_by_runtime_before_program_executes() {
    let mut fixture = Fixture::new();
    let actor = fixture.actor();
    let instruction = fixture.instruction(actor.pubkey(), SMALL_SLOT, fixture.buy_data(&fixture.state(SMALL_SLOT), content("Forged")));
    let message = Message::new_with_blockhash(&[instruction], Some(&actor.pubkey()), &fixture.svm.latest_blockhash());
    let result = fixture.svm.send_transaction(Transaction::new_unsigned(message));
    assert!(result.is_err());
    assert!(fixture.svm.get_account(&fixture.address(SMALL_SLOT)).is_none());
}

#[test]
fn substitution_of_treasury_pda_system_or_account_owner_is_rejected() {
    let mut fixture = Fixture::new();
    let buyer = fixture.actor();
    let intruder = fixture.actor();
    let original = fixture.instruction(buyer.pubkey(), SMALL_SLOT, fixture.buy_data(&fixture.state(SMALL_SLOT), content("Attack")));
    let mut wrong_treasury = original.clone();
    wrong_treasury.accounts[2].pubkey = intruder.pubkey();
    assert_error(fixture.send(&buyer, wrong_treasury), MarketError::WrongTreasury);
    let mut wrong_pda = original.clone();
    wrong_pda.accounts[1].pubkey = fixture.address(SMALL_SLOT + 1);
    assert_error(fixture.send(&buyer, wrong_pda), MarketError::InvalidAccounts);
    let mut wrong_system = original.clone();
    wrong_system.accounts[3].pubkey = intruder.pubkey();
    assert_error(fixture.send(&buyer, wrong_system), MarketError::WrongSystemProgram);
    fixture.svm.set_account(fixture.address(SMALL_SLOT), Account {
        lamports: 20_000_000, data: vec![0; STATE_LEN], owner: Pubkey::new_unique(),
        executable: false, rent_epoch: 0,
    }).unwrap();
    assert_error(fixture.send(&buyer, original), MarketError::InvalidState);
}

#[test]
fn readonly_accounts_and_non_wallet_actor_are_rejected() {
    let mut fixture = Fixture::new();
    let buyer = fixture.actor();
    let payer = fixture.actor();
    let original = fixture.instruction(buyer.pubkey(), SMALL_SLOT, fixture.buy_data(&fixture.state(SMALL_SLOT), content("Bad account metas")));
    for index in [0, 1, 2] {
        let mut instruction = original.clone();
        instruction.accounts[index].is_writable = false;
        // A distinct fee payer prevents the actor from being promoted to a
        // writable account by transaction-wide privilege merging.
        assert_error(fixture.send_sponsored(&buyer, &payer, instruction), MarketError::InvalidAccounts);
    }
    for (owner, data) in [(Pubkey::new_unique(), vec![]), (system_program::id(), vec![1])] {
        fixture.svm.set_account(buyer.pubkey(), Account {
            lamports: FUNDS, data, owner, executable: false, rent_epoch: 0,
        }).unwrap();
        assert_error(fixture.send_sponsored(&buyer, &payer, original.clone()), MarketError::InvalidAccounts);
    }
    assert!(fixture.svm.get_account(&fixture.address(SMALL_SLOT)).is_none());
}

#[test]
fn official_ca_and_social_are_not_market_slots() {
    let mut fixture = Fixture::new();
    let buyer = fixture.actor();
    for id in [62_u16, 63, 255, u16::MAX] {
        let data = MarketInstruction::Buy {
            id, expected_owner: Pubkey::default(), expected_paid: 0, expected_version: 0,
            payment: 100_000_000, content: content("Cannot buy official information"),
        }.pack();
        let instruction = fixture.instruction(buyer.pubkey(), id, data);
        assert_error(fixture.send(&buyer, instruction), MarketError::InvalidSlot);
    }
}

#[test]
fn prefunded_system_pda_can_be_claimed_and_existing_lamports_reduce_rent_cost() {
    let mut fixture = Fixture::new();
    let buyer = fixture.actor();
    let donated_lamports = 1_000_000;
    let address = fixture.address(SMALL_SLOT);
    fixture.svm.set_account(address, Account {
        lamports: donated_lamports, data: vec![], owner: system_program::id(),
        executable: false, rent_epoch: 0,
    }).unwrap();
    let before = fixture.balance(&buyer.pubkey());
    fixture.buy(&buyer, SMALL_SLOT).unwrap();
    let rent = fixture.svm.get_sysvar::<Rent>().minimum_balance(STATE_LEN);
    assert_eq!(fixture.balance(&address), rent);
    assert_eq!(before - fixture.balance(&buyer.pubkey()), 100_000_000 + rent - donated_lamports + 5_000);
    assert_eq!(fixture.state(SMALL_SLOT).owner, buyer.pubkey());
}

#[test]
fn over_prefunded_pda_needs_no_rent_top_up_and_keeps_its_donated_lamports() {
    let mut fixture = Fixture::new();
    let buyer = fixture.actor();
    let rent = fixture.svm.get_sysvar::<Rent>().minimum_balance(STATE_LEN);
    let donated_lamports = rent + 1_234_567;
    let address = fixture.address(SMALL_SLOT);
    fixture.svm.set_account(address, Account {
        lamports: donated_lamports, data: vec![], owner: system_program::id(),
        executable: false, rent_epoch: 0,
    }).unwrap();
    let before = fixture.balance(&buyer.pubkey());
    fixture.buy(&buyer, SMALL_SLOT).unwrap();
    assert_eq!(fixture.balance(&address), donated_lamports);
    assert_eq!(before - fixture.balance(&buyer.pubkey()), 100_000_000 + 5_000);
    assert_eq!(fixture.state(SMALL_SLOT).owner, buyer.pubkey());
}

#[test]
fn insufficient_purchase_funds_roll_back_earlier_rent_and_allocation_cpis() {
    let mut fixture = Fixture::new();
    let buyer = fixture.actor();
    fixture.svm.set_account(buyer.pubkey(), Account {
        lamports: 50_000_000, data: vec![], owner: system_program::id(),
        executable: false, rent_epoch: 0,
    }).unwrap();
    let treasury_before = fixture.balance(&TREASURY);
    assert_error(fixture.buy(&buyer, SMALL_SLOT), MarketError::InsufficientFunds);
    assert!(fixture.svm.get_account(&fixture.address(SMALL_SLOT)).is_none(), "rent funding/allocation must roll back");
    assert_eq!(fixture.balance(&TREASURY), treasury_before);
}

#[test]
fn admin_can_remove_and_lock_content_without_taking_ownership_or_payment() {
    let mut fixture = Fixture::new();
    let owner = fixture.actor();
    let second = fixture.actor();
    fixture.buy(&owner, SMALL_SLOT).unwrap();
    let before = fixture.state(SMALL_SLOT);
    fixture.moderate(SMALL_SLOT, true, Content::default()).unwrap();
    let moderated = fixture.state(SMALL_SLOT);
    assert_eq!(moderated.owner, before.owner);
    assert_eq!(moderated.paid, before.paid);
    assert_eq!(moderated.version, before.version + 1);
    assert!(moderated.locked);
    assert_eq!(moderated.content, Content::default());
    assert_error(fixture.edit(&owner, SMALL_SLOT, content("Bypass edit")), MarketError::Locked);
    assert_error(fixture.buy(&owner, SMALL_SLOT), MarketError::Locked);
    fixture.buy(&second, SMALL_SLOT).unwrap();
    assert_eq!(fixture.state(SMALL_SLOT).owner, second.pubkey());
    assert!(!fixture.state(SMALL_SLOT).locked);
}

#[test]
fn admin_can_prepare_unclaimed_slot_and_unlock_while_preserving_market_state() {
    let mut fixture = Fixture::new();
    fixture.moderate(SMALL_SLOT, true, content("Moderated placeholder")).unwrap();
    let state = fixture.state(SMALL_SLOT);
    assert_eq!(state.owner, Pubkey::default());
    assert_eq!(state.paid, 0);
    assert_eq!(state.version, 1);
    assert_eq!(state.price().unwrap(), 100_000_000);
    assert!(state.locked);
    fixture.moderate(SMALL_SLOT, false, content("Updated placeholder")).unwrap();
    assert!(!fixture.state(SMALL_SLOT).locked);
    let buyer = fixture.actor();
    fixture.buy(&buyer, SMALL_SLOT).unwrap();
    assert_eq!(fixture.state(SMALL_SLOT).paid, 100_000_000);
    assert_eq!(fixture.state(SMALL_SLOT).version, 3);
}

#[test]
fn stale_admin_moderation_cannot_overwrite_concurrent_owner_edit_or_takeover() {
    let mut fixture = Fixture::new();
    let first = fixture.actor();
    let second = fixture.actor();
    fixture.buy(&first, SMALL_SLOT).unwrap();
    for takeover in [false, true] {
        let previous = fixture.state(SMALL_SLOT);
        let instruction = fixture.instruction(TREASURY, SMALL_SLOT, MarketInstruction::AdminEdit {
            id: SMALL_SLOT, expected_version: previous.version, locked: true, content: Content::default(),
        }.pack());
        if takeover {
            fixture.buy(&second, SMALL_SLOT).unwrap();
        } else {
            fixture.edit(&first, SMALL_SLOT, content("Concurrent owner edit")).unwrap();
        }
        let current = fixture.state(SMALL_SLOT);
        assert_error(fixture.admin_fixture(instruction), MarketError::StaleQuote);
        assert_eq!(fixture.state(SMALL_SLOT), current);
    }
}

#[test]
fn unlocked_owner_may_repurchase_but_treasury_purchase_has_no_self_transfer() {
    let mut fixture = Fixture::new();
    let buyer = fixture.actor();
    fixture.buy(&buyer, SMALL_SLOT).unwrap();
    fixture.buy(&buyer, SMALL_SLOT).unwrap();
    assert_eq!(fixture.state(SMALL_SLOT).paid, 200_000_000);
    let before = fixture.balance(&TREASURY);
    let state = fixture.state(SMALL_SLOT);
    let instruction = fixture.instruction(TREASURY, SMALL_SLOT, fixture.buy_data(&state, content("Treasury ad")));
    fixture.admin_fixture(instruction).unwrap();
    assert_eq!(fixture.balance(&TREASURY), before - 5_000, "only transaction fee for self-transfer");
    assert_eq!(fixture.state(SMALL_SLOT).owner, TREASURY);
    assert_eq!(fixture.state(SMALL_SLOT).paid, 400_000_000);
}

#[test]
fn treasury_purchase_still_requires_full_quote_balance() {
    let mut fixture = Fixture::new();
    fixture.svm.set_account(TREASURY, Account {
        lamports: 50_000_000, data: vec![], owner: system_program::id(),
        executable: false, rent_epoch: 0,
    }).unwrap();
    let instruction = fixture.instruction(TREASURY, SMALL_SLOT, fixture.buy_data(&fixture.state(SMALL_SLOT), content("Not funded")));
    assert_error(fixture.admin_fixture(instruction), MarketError::InsufficientFunds);
    assert!(fixture.svm.get_account(&fixture.address(SMALL_SLOT)).is_none());
}

#[test]
fn arithmetic_overflow_cannot_corrupt_state_or_charge_buyer() {
    let mut fixture = Fixture::new();
    let first = fixture.actor();
    let second = fixture.actor();
    fixture.buy(&first, SMALL_SLOT).unwrap();
    for overflow_price in [true, false] {
        let mut state = fixture.state(SMALL_SLOT);
        state.paid = if overflow_price { u64::MAX / 2 + 1 } else { 100_000_000 };
        state.version = if overflow_price { 1 } else { u64::MAX };
        let mut account = fixture.svm.get_account(&fixture.address(SMALL_SLOT)).unwrap();
        state.pack(&mut account.data).unwrap();
        fixture.svm.set_account(fixture.address(SMALL_SLOT), account.clone()).unwrap();
        let before = fixture.balance(&TREASURY);
        let instruction = fixture.instruction(second.pubkey(), SMALL_SLOT, MarketInstruction::Buy {
            id: SMALL_SLOT, expected_owner: state.owner, expected_paid: state.paid,
            expected_version: state.version, payment: 200_000_000, content: content("Overflow"),
        }.pack());
        assert_error(fixture.send(&second, instruction), MarketError::ArithmeticOverflow);
        assert_eq!(fixture.svm.get_account(&fixture.address(SMALL_SLOT)).unwrap().data, account.data);
        assert_eq!(fixture.balance(&TREASURY), before);
    }
}

#[test]
fn invalid_utf8_content_lengths_and_unsafe_urls_fail_before_payment() {
    let mut fixture = Fixture::new();
    let buyer = fixture.actor();
    let before = fixture.balance(&TREASURY);
    let invalid = [
        Content { text: "é".repeat(141), ..Content::default() },
        Content { text: "zero\0byte".into(), ..Content::default() },
        Content { text: "control\u{0085}byte".into(), ..Content::default() },
        Content { image: "javascript:alert(1)".into(), ..Content::default() },
        Content { image: "http://example.com/ad.png".into(), ..Content::default() },
        Content { link: "https://trusted.example@evil.example/".into(), ..Content::default() },
        Content { link: "https://evil.example\\@trusted.example/".into(), ..Content::default() },
        Content { link: "https://example.com/%ZZ".into(), ..Content::default() },
        Content { image: format!("https://example.com/{}", "a".repeat(240)), ..Content::default() },
    ];
    for value in invalid {
        let instruction = fixture.instruction(buyer.pubkey(), SMALL_SLOT, fixture.buy_data(&fixture.state(SMALL_SLOT), value));
        assert_error(fixture.send(&buyer, instruction), MarketError::InvalidContent);
        assert!(fixture.svm.get_account(&fixture.address(SMALL_SLOT)).is_none());
        assert_eq!(fixture.balance(&TREASURY), before);
    }
    // Buy header is 59 bytes, first string length takes two bytes.
    let mut bytes = fixture.buy_data(&fixture.state(SMALL_SLOT), content("a"));
    bytes[61] = 0xff;
    let instruction = fixture.instruction(buyer.pubkey(), SMALL_SLOT, bytes);
    assert_error(fixture.send(&buyer, instruction), MarketError::InvalidContent);
}

#[test]
fn malformed_instruction_and_corrupt_owned_state_are_rejected() {
    let mut fixture = Fixture::new();
    let buyer = fixture.actor();
    let original = fixture.buy_data(&fixture.state(SMALL_SLOT), content("Ad"));
    let mut trailing = original.clone();
    trailing.push(0);
    for data in [vec![], vec![9, 18, 0], original[..20].to_vec(), trailing] {
        let instruction = fixture.instruction(buyer.pubkey(), SMALL_SLOT, data);
        assert_error(fixture.send(&buyer, instruction), MarketError::InvalidInstruction);
    }
    fixture.buy(&buyer, SMALL_SLOT).unwrap();
    let mut account = fixture.svm.get_account(&fixture.address(SMALL_SLOT)).unwrap();
    account.data[340] = 1; // Noncanonical text padding must never be accepted.
    fixture.svm.set_account(fixture.address(SMALL_SLOT), account).unwrap();
    let instruction = fixture.instruction(buyer.pubkey(), SMALL_SLOT, MarketInstruction::Edit {
        id: SMALL_SLOT, expected_version: 1, content: content("Repair bypass"),
    }.pack());
    assert_error(fixture.send(&buyer, instruction), MarketError::InvalidState);
}

#[test]
fn maximum_content_payload_fits_one_legacy_transaction_and_round_trips() {
    let mut fixture = Fixture::new();
    let buyer = fixture.actor();
    let prefix = "https://example.com/";
    let value = Content {
        text: "é".repeat(140),
        image: format!("{prefix}{}", "a".repeat(256 - prefix.len())),
        link: format!("{prefix}{}", "b".repeat(256 - prefix.len())),
    };
    let instruction = fixture.instruction(buyer.pubkey(), SMALL_SLOT, fixture.buy_data(&fixture.state(SMALL_SLOT), value.clone()));
    let transaction = Transaction::new_signed_with_payer(&[instruction], Some(&buyer.pubkey()), &[&buyer], fixture.svm.latest_blockhash());
    // The wire payload consists of one signature and the serialized message.
    assert!(1 + 64 + transaction.message_data().len() <= 1232);
    fixture.svm.send_transaction(transaction).unwrap();
    assert_eq!(fixture.state(SMALL_SLOT).content, value);
}
