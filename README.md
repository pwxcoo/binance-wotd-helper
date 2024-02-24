# Binance WOTD Helper Tool

## Overview
This script serves as a helper tool for the Binance "Word of the Day" (WOTD) challenge. The WOTD is a daily game where participants guess a word based on certain clues provided by Binance. The tool is designed to filter and suggest words that match the given criteria, making it easier for users to guess the correct word.

## How It Works
The script processes a list of words and applies a series of filters to narrow down the potential matches based on the rules and clues provided for the WOTD. The filters include:

- Ensuring that the word consists of alphabetic characters only.
- Checking the word length to match the expected number of characters (typically four).
- Excluding words that contain certain unwanted letters.
- Making sure that the word contains certain required letters.
- Verifying that certain letters are not present at specific positions in the word.
- Ensuring that certain letters are placed at specific positions in the word.

After applying all the necessary filters, the script also counts the occurrences of each letter in the surviving words and calculates a score for each word based on the frequency of the letters it contains. Words are then sorted by the unique number of letters they contain and their score, with the results printed out for the user.

By using this tool, participants can significantly cut down the number of possible words and focus their effort on a smaller, more targeted subset of words, increasing their chances of success in the WOTD challenge.

## Usage
To use the script, simply supply it with a word list file (the script includes links to possible sources for common words and all words). The script expects a text file with one word per line. Run the script using Python, and it will output a filtered and sorted list of word candidates according to the provided criteria.


python wotd_helper.py



## Requirements
- Python 3.x

## Disclaimer
This script is for educational and fun purposes only. It is up to the user to use this tool responsibly and in accordance with Binance's rules and regulations related to the WOTD challenge.