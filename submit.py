import requests
import yaml
import json
import time

cookie = ''
csrftoken = ''
activityId = ''
letter_count = 7
with open('configuration.yml', 'r') as f:
    config = yaml.safe_load(f)
    cookie = config['cookie']
    csrftoken = config['csrftoken']
    activityId = config['activityId']
    letter_count = config['letterCount']

common_words_list = []
with open('./common_words.txt', mode='r', encoding='utf-8') as fp:
    common_words_list = fp.readlines()
all_words_list = []
with open('./words.txt', mode='r', encoding='utf-8') as fp:
    all_words_list = fp.readlines()


def verify(word, exclude_letter_list, required_but_invalid_positions_list, right_letter_list, failed_words_list):
    url = "https://www.binance.com/bapi/composite/v1/private/growth-activity/wodl/verify"
    payload = json.dumps({
        "wodl": word,
        "activityId": activityId
    })
    headers = {
        'accept': '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'bnc-location': 'BINANCE',
        'clienttype': 'web',
        'content-type': 'application/json',
        'cookie': cookie,
        'csrftoken': csrftoken,
        'lang': 'en',
        'origin': 'https://www.binance.com',
        'priority': 'u=1, i',
        'sec-ch-ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
    }

    response = requests.request("POST", url, headers=headers, data=payload)
    print(word + " " + response.text)
    if response.status_code != 200:
        raise Exception("invoke failed: " + response.text)

    response_json = json.loads(response.text)
    if response_json['success'] != True:
        failed_words_list.append(word)
        return False

    if 'data' not in response_json or 'result' not in response_json['data']:
        raise Exception("parse result failed: " + response.text)

    if response_json['data']['pass'] == True:
        return True
    
    for pos, letter_result in enumerate(response_json['data']['result']):
        # 位置正确，字母正确
        if letter_result == 2:
            right_letter_list.append((pos, word[pos]))
        # 位置正确，字母错误
        elif letter_result == 1:
            required_but_invalid_positions_list.append((pos, word[pos]))
        # 预期没有这个字母
        elif letter_result == 0:
            exclude_letter_list.append(word[pos])
        else:
            raise Exception("unknown result: " + response_json['data']['result'])
    
    # 从 exclude_letter_list 中移除在 required_but_invalid_positions_list 中出现的字母
    letters_to_remove = set(letter for _, letter in required_but_invalid_positions_list)
    exclude_letter_list = [letter for letter in exclude_letter_list if letter not in letters_to_remove]
    
    print("exclude_letter_list: " + json.dumps(exclude_letter_list))
    print("required_but_invalid_positions_list: " + json.dumps(required_but_invalid_positions_list))
    print("right_letter_list: " + json.dumps(right_letter_list))
    print("failed_words_list: " + json.dumps(failed_words_list))
    print("========================")
    time.sleep(2)
    return False

def sort_words(matchedList):
    # Count the occurrence of each letter in the words
    letter_count = {}
    # Iterate through the list of words, updating the count of each letter
    for word in matchedList:
        for letter in word:
            letter_count[letter] = letter_count.get(letter, 0) + 1
    # Print the letter count result
    print("Letter count:", letter_count)
    # How many different letters are there
    def unique_letter_count(word):
        return len(set(word))
    # Score each word
    def word_score(word, letter_count):
        return sum(letter_count.get(letter, 0) for letter in word)
    # Create a new list containing the original word and its score
    sortedWordList = [(word, word_score(word, letter_count)) for word in matchedList]
    # Sort the list by score in descending order
    sortedWordList.sort(key=lambda x: (unique_letter_count(x[0]), x[1]), reverse=True)

    return [word for word, score in sortedWordList]

def match_words(letter_count, exclude_letter_list, required_but_invalid_positions_list, right_letter_list, failed_words_list, origin_words_list):
    matchedList = []

    for word in origin_words_list:
        word = word.strip()
        if len(word) != letter_count:
            continue
        if word in failed_words_list:
            continue
        
        if any(letter in word for letter in exclude_letter_list):
            continue
        
        not_match = False
        for pos, letter in required_but_invalid_positions_list:
            if letter not in word:
                not_match = True
                break
            if pos < len(word) and word[pos] == letter:
                not_match = True
                break
        if not_match:
            continue
        
        if not all(word[pos] == letter for pos,letter in right_letter_list):
            continue
        
        matchedList.append(word)
    
    return matchedList

def nexs_word(letter_count, exclude_letter_list, required_but_invalid_positions_list, right_letter_list, failed_words_list):
    matchedList = match_words(letter_count, exclude_letter_list, required_but_invalid_positions_list, right_letter_list, failed_words_list, common_words_list)
    
    if len(matchedList) == 0:
        matchedList - match_words(letter_count, exclude_letter_list, required_but_invalid_positions_list, right_letter_list, failed_words_list, all_words_list)
        
    sort_words_list = sort_words(matchedList)
    return sort_words_list[0] 
    

if __name__ == "__main__":
    exclude_letter_list = []
    required_but_invalid_positions_list = []
    right_letter_list = []
    failed_words_list = []

    is_correct = False
    tryTime = 0
    while not is_correct or tryTime < 3:
        tryTime += 1
        is_correct = verify(nexs_word(letter_count, exclude_letter_list, required_but_invalid_positions_list, right_letter_list, failed_words_list), exclude_letter_list, required_but_invalid_positions_list, right_letter_list, failed_words_list)