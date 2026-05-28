
import random

def guess_the_number_v2():
    """
    A second version of the "Guess the Number" game with a smaller range.
    The computer picks a random number between 1 and 50.
    """
    print("\nWelcome to Guess the Number V2!")
    print("I'm thinking of a number between 1 and 50.")
    print("You have 7 attempts to guess it.")

    secret_number = random.randint(1, 50)
    attempts = 0
    max_attempts = 7

    while attempts < max_attempts:
        try:
            player_guess = int(input(f"Attempt {attempts + 1}/{max_attempts}. Enter your guess: "))
            attempts += 1

            if player_guess < 1 or player_guess > 50:
                print("Please guess a number between 1 and 50.")
            elif player_guess < secret_number:
                print("Too low!")
            elif player_guess > secret_number:
                print("Too high!")
            else:
                print(f"Congratulations! You guessed the number {secret_number} in {attempts} attempts!")
                break # Exit the loop if the guess is correct
        except ValueError:
            print("Invalid input. Please enter a whole number.")
        except Exception as e:
            print(f"An unexpected error occurred: {e}")
    else: # This block executes if the while loop completes without a 'break'
        print(f"Sorry, you ran out of attempts! The number was {secret_number}.")

    play_again = input("Do you want to play again? (yes/no): ").lower()
    if play_again == 'yes':
        guess_the_number_v2()
    else:
        print("Thanks for playing V2! Goodbye.")

# Start the game
if __name__ == "__main__":
    guess_the_number_v2()
