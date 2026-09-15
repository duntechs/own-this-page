//! Native SOL advertising marketplace. There is no token mint, token approval,
//! mutable treasury, market initializer, administrator withdrawal, or escrow.
//! The PDA accounts store slot ownership/content; every purchase pays the fixed
//! treasury directly. See ../ABI.md for the public binary interface.

use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::Sysvar,
};

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

include!(concat!(env!("OUT_DIR"), "/catalog.rs"));

pub const TREASURY: Pubkey = pubkey!("8Rxj2R1c3kUGcdKYyLEXkzYvARxrrvFFtSEwhBPz1WN9");
pub const MAGIC: &[u8; 8] = b"SLOTMKT1";
pub const STATE_LEN: usize = 857;
pub const MAX_TEXT: usize = 280;
pub const MAX_IMAGE: usize = 256;
pub const MAX_LINK: usize = 256;

#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarketError {
    InvalidInstruction = 6000,
    InvalidSlot = 6001,
    InvalidAccounts = 6002,
    MissingSignature = 6003,
    WrongTreasury = 6004,
    InvalidState = 6005,
    StaleQuote = 6006,
    WrongPayment = 6007,
    NotOwner = 6008,
    Locked = 6009,
    NotAdmin = 6010,
    ArithmeticOverflow = 6011,
    InvalidContent = 6012,
    InsufficientFunds = 6013,
    WrongSystemProgram = 6014,
}

impl From<MarketError> for ProgramError {
    fn from(error: MarketError) -> Self {
        ProgramError::Custom(error as u32)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Content {
    pub text: String,
    pub image: String,
    pub link: String,
}

impl Content {
    pub fn validate(&self) -> ProgramResult {
        if self.text.len() > MAX_TEXT
            || self.image.len() > MAX_IMAGE
            || self.link.len() > MAX_LINK
            || self.text.chars().any(|c| c.is_control() && c != '\n' && c != '\t')
            || !valid_url(&self.image)
            || !valid_url(&self.link)
        {
            return Err(MarketError::InvalidContent.into());
        }
        Ok(())
    }
}

/// Empty or an absolute ASCII HTTPS URL, without credentials or ambiguous URL
/// delimiters. This program never fetches the URL. Rendering must still escape
/// content, and external links must use noopener/noreferrer in the website.
pub fn valid_url(value: &str) -> bool {
    if value.is_empty() {
        return true;
    }
    let Some(rest) = value.strip_prefix("https://") else {
        return false;
    };
    if !value.is_ascii()
        || value.bytes().any(|b| b <= b' ' || b == 127 || b"\\\"'<>`".contains(&b))
    {
        return false;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') {
        return false;
    }
    let (host, port) = authority
        .split_once(':')
        .map_or((authority, None), |(host, port)| (host, Some(port)));
    if let Some(port) = port {
        if port.is_empty()
            || !port.bytes().all(|b| b.is_ascii_digit())
            || port.parse::<u16>().map_or(true, |value| value == 0)
        {
            return false;
        }
    }
    if host.is_empty()
        || host.len() > 253
        || host.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
    {
        return false;
    }
    let bytes = value.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'%'
            && (index + 2 >= bytes.len()
                || !bytes[index + 1].is_ascii_hexdigit()
                || !bytes[index + 2].is_ascii_hexdigit())
        {
            return false;
        }
    }
    true
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SlotState {
    pub id: u16,
    pub owner: Pubkey,
    pub paid: u64,
    pub version: u64,
    pub locked: bool,
    pub content: Content,
}

impl SlotState {
    pub fn unclaimed(id: u16) -> Self {
        Self {
            id,
            owner: Pubkey::default(),
            paid: 0,
            version: 0,
            locked: false,
            content: Content::default(),
        }
    }

    pub fn price(&self) -> Result<u64, ProgramError> {
        let base = *BASE_PRICES
            .get(self.id as usize)
            .ok_or(MarketError::InvalidSlot)?;
        if self.owner == Pubkey::default() {
            Ok(base)
        } else {
            self.paid
                .checked_mul(2)
                .ok_or_else(|| MarketError::ArithmeticOverflow.into())
        }
    }

    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() != STATE_LEN || &data[..8] != MAGIC || data[58] > 1 {
            return Err(MarketError::InvalidState.into());
        }
        let state = Self {
            id: u16::from_le_bytes(data[8..10].try_into().unwrap()),
            owner: Pubkey::new_from_array(data[10..42].try_into().unwrap()),
            paid: u64::from_le_bytes(data[42..50].try_into().unwrap()),
            version: u64::from_le_bytes(data[50..58].try_into().unwrap()),
            locked: data[58] == 1,
            content: Content {
                text: read_fixed_string(data, 59, MAX_TEXT)?,
                image: read_fixed_string(data, 341, MAX_IMAGE)?,
                link: read_fixed_string(data, 599, MAX_LINK)?,
            },
        };
        if state.id as usize >= SLOT_COUNT
            || (state.owner == Pubkey::default()) != (state.paid == 0)
            || state.version == 0
        {
            return Err(MarketError::InvalidState.into());
        }
        state.content.validate()?;
        Ok(state)
    }

    pub fn pack(&self, data: &mut [u8]) -> ProgramResult {
        if data.len() != STATE_LEN {
            return Err(MarketError::InvalidState.into());
        }
        self.content.validate()?;
        data.fill(0);
        data[..8].copy_from_slice(MAGIC);
        data[8..10].copy_from_slice(&self.id.to_le_bytes());
        data[10..42].copy_from_slice(self.owner.as_ref());
        data[42..50].copy_from_slice(&self.paid.to_le_bytes());
        data[50..58].copy_from_slice(&self.version.to_le_bytes());
        data[58] = u8::from(self.locked);
        write_fixed_string(data, 59, &self.content.text);
        write_fixed_string(data, 341, &self.content.image);
        write_fixed_string(data, 599, &self.content.link);
        Ok(())
    }
}

fn read_fixed_string(data: &[u8], offset: usize, max: usize) -> Result<String, ProgramError> {
    let length = u16::from_le_bytes(data[offset..offset + 2].try_into().unwrap()) as usize;
    if length > max || data[offset + 2 + length..offset + 2 + max].iter().any(|b| *b != 0) {
        return Err(MarketError::InvalidState.into());
    }
    std::str::from_utf8(&data[offset + 2..offset + 2 + length])
        .map(str::to_owned)
        .map_err(|_| MarketError::InvalidState.into())
}

fn write_fixed_string(data: &mut [u8], offset: usize, value: &str) {
    data[offset..offset + 2].copy_from_slice(&(value.len() as u16).to_le_bytes());
    data[offset + 2..offset + 2 + value.len()].copy_from_slice(value.as_bytes());
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MarketInstruction {
    Buy {
        id: u16,
        expected_owner: Pubkey,
        expected_paid: u64,
        expected_version: u64,
        payment: u64,
        content: Content,
    },
    Edit {
        id: u16,
        expected_version: u64,
        content: Content,
    },
    AdminEdit {
        id: u16,
        expected_version: u64,
        locked: bool,
        content: Content,
    },
}

impl MarketInstruction {
    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        let mut reader = Reader { data, offset: 0 };
        let op = reader.byte()?;
        let id = reader.u16()?;
        if id as usize >= SLOT_COUNT {
            return Err(MarketError::InvalidSlot.into());
        }
        let instruction = match op {
            0 => Self::Buy {
                id,
                expected_owner: Pubkey::new_from_array(reader.take(32)?.try_into().unwrap()),
                expected_paid: reader.u64()?,
                expected_version: reader.u64()?,
                payment: reader.u64()?,
                content: reader.content()?,
            },
            1 => Self::Edit {
                id,
                expected_version: reader.u64()?,
                content: reader.content()?,
            },
            2 => Self::AdminEdit {
                id,
                expected_version: reader.u64()?,
                locked: match reader.byte()? {
                    0 => false,
                    1 => true,
                    _ => return Err(MarketError::InvalidInstruction.into()),
                },
                content: reader.content()?,
            },
            _ => return Err(MarketError::InvalidInstruction.into()),
        };
        if reader.offset != data.len() {
            return Err(MarketError::InvalidInstruction.into());
        }
        Ok(instruction)
    }

    pub fn pack(&self) -> Vec<u8> {
        let mut data = Vec::new();
        let content = match self {
            Self::Buy { id, expected_owner, expected_paid, expected_version, payment, content } => {
                data.push(0);
                data.extend_from_slice(&id.to_le_bytes());
                data.extend_from_slice(expected_owner.as_ref());
                data.extend_from_slice(&expected_paid.to_le_bytes());
                data.extend_from_slice(&expected_version.to_le_bytes());
                data.extend_from_slice(&payment.to_le_bytes());
                content
            }
            Self::Edit { id, expected_version, content } => {
                data.push(1);
                data.extend_from_slice(&id.to_le_bytes());
                data.extend_from_slice(&expected_version.to_le_bytes());
                content
            }
            Self::AdminEdit { id, expected_version, locked, content } => {
                data.push(2);
                data.extend_from_slice(&id.to_le_bytes());
                data.extend_from_slice(&expected_version.to_le_bytes());
                data.push(u8::from(*locked));
                content
            }
        };
        for value in [&content.text, &content.image, &content.link] {
            data.extend_from_slice(&(value.len() as u16).to_le_bytes());
            data.extend_from_slice(value.as_bytes());
        }
        data
    }

    fn id(&self) -> u16 {
        match self {
            Self::Buy { id, .. } | Self::Edit { id, .. } | Self::AdminEdit { id, .. } => *id,
        }
    }
}

struct Reader<'a> {
    data: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, length: usize) -> Result<&'a [u8], ProgramError> {
        let end = self.offset.checked_add(length).ok_or(MarketError::InvalidInstruction)?;
        let result = self.data.get(self.offset..end).ok_or(MarketError::InvalidInstruction)?;
        self.offset = end;
        Ok(result)
    }
    fn byte(&mut self) -> Result<u8, ProgramError> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, ProgramError> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Result<u64, ProgramError> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn string(&mut self, max: usize) -> Result<String, ProgramError> {
        let length = self.u16()? as usize;
        if length > max {
            return Err(MarketError::InvalidContent.into());
        }
        std::str::from_utf8(self.take(length)?)
            .map(str::to_owned)
            .map_err(|_| MarketError::InvalidContent.into())
    }
    fn content(&mut self) -> Result<Content, ProgramError> {
        let content = Content {
            text: self.string(MAX_TEXT)?,
            image: self.string(MAX_IMAGE)?,
            link: self.string(MAX_LINK)?,
        };
        content.validate()?;
        Ok(content)
    }
}

pub fn slot_address(program_id: &Pubkey, id: u16) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"slot", &id.to_le_bytes()], program_id)
}

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let instruction = MarketInstruction::unpack(data)?;
    let id = instruction.id();
    if accounts.len() != 4 {
        return Err(MarketError::InvalidAccounts.into());
    }
    let actor = &accounts[0];
    let slot = &accounts[1];
    let treasury = &accounts[2];
    let system = &accounts[3];
    if !actor.is_signer {
        return Err(MarketError::MissingSignature.into());
    }
    if *treasury.key != TREASURY {
        return Err(MarketError::WrongTreasury.into());
    }
    if *system.key != system_program::id() || !system.executable {
        return Err(MarketError::WrongSystemProgram.into());
    }
    let (expected_slot, bump) = slot_address(program_id, id);
    if *slot.key != expected_slot
        || actor.key == slot.key
        || treasury.key == slot.key
        || slot.executable
        || actor.executable
        || actor.owner != &system_program::id()
        || !actor.data_is_empty()
        || !actor.is_writable
        || !slot.is_writable
        || !treasury.is_writable
    {
        return Err(MarketError::InvalidAccounts.into());
    }
    let needs_creation = slot.owner == &system_program::id() && slot.data_is_empty();
    let mut state = if needs_creation {
        SlotState::unclaimed(id)
    } else {
        if slot.owner != program_id {
            return Err(MarketError::InvalidState.into());
        }
        let state = SlotState::unpack(&slot.try_borrow_data()?)?;
        if state.id != id {
            return Err(MarketError::InvalidState.into());
        }
        state
    };
    // Validate all quotes, authority, arithmetic and content BEFORE any CPI.
    // The runtime rolls back the entire instruction if a later CPI fails.
    let transfer = match instruction {
        MarketInstruction::Buy { expected_owner, expected_paid, expected_version, payment, content, .. } => {
            if expected_owner != state.owner || expected_paid != state.paid || expected_version != state.version {
                return Err(MarketError::StaleQuote.into());
            }
            if state.locked && actor.key == &state.owner {
                return Err(MarketError::Locked.into());
            }
            if payment != state.price()? {
                return Err(MarketError::WrongPayment.into());
            }
            state.owner = *actor.key;
            state.paid = payment;
            state.locked = false;
            state.content = content;
            payment
        }
        MarketInstruction::Edit { expected_version, content, .. } => {
            if state.owner != *actor.key || state.owner == Pubkey::default() {
                return Err(MarketError::NotOwner.into());
            }
            if state.locked {
                return Err(MarketError::Locked.into());
            }
            if expected_version != state.version {
                return Err(MarketError::StaleQuote.into());
            }
            state.content = content;
            0
        }
        MarketInstruction::AdminEdit { expected_version, locked, content, .. } => {
            if *actor.key != TREASURY {
                return Err(MarketError::NotAdmin.into());
            }
            if expected_version != state.version {
                return Err(MarketError::StaleQuote.into());
            }
            state.content = content;
            state.locked = locked;
            0
        }
    };
    state.version = state.version.checked_add(1).ok_or(MarketError::ArithmeticOverflow)?;
    if needs_creation {
        create_slot(program_id, actor, slot, system, id, bump)?;
    }
    if transfer != 0 {
        // A treasury purchase transfers to the same wallet and has no net
        // transfer. Still require the full quote after any account-creation
        // charge, so an empty admin wallet cannot fabricate a paid price.
        if actor.lamports() < transfer {
            return Err(MarketError::InsufficientFunds.into());
        }
        if actor.key != treasury.key {
            invoke(
                &system_instruction::transfer(actor.key, treasury.key, transfer),
                &[actor.clone(), treasury.clone(), system.clone()],
            )?;
        }
    }
    state.pack(&mut slot.try_borrow_mut_data()?)
}

fn create_slot<'a>(
    program_id: &Pubkey,
    actor: &AccountInfo<'a>,
    slot: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    id: u16,
    bump: u8,
) -> ProgramResult {
    let required_rent = Rent::get()?.minimum_balance(STATE_LEN);
    let top_up = required_rent.saturating_sub(slot.lamports());
    if top_up != 0 {
        if actor.lamports() < top_up {
            return Err(MarketError::InsufficientFunds.into());
        }
        invoke(
            &system_instruction::transfer(actor.key, slot.key, top_up),
            &[actor.clone(), slot.clone(), system.clone()],
        )?;
    }
    // Allocate + assign instead of create_account also accepts a system-owned
    // PDA someone prefunded, preventing a one-lamport denial of service.
    let id_bytes = id.to_le_bytes();
    let bump_bytes = [bump];
    let seeds: &[&[u8]] = &[b"slot", &id_bytes, &bump_bytes];
    invoke_signed(
        &system_instruction::allocate(slot.key, STATE_LEN as u64),
        &[slot.clone(), system.clone()],
        &[seeds],
    )?;
    invoke_signed(
        &system_instruction::assign(slot.key, program_id),
        &[slot.clone(), system.clone()],
        &[seeds],
    )
}
